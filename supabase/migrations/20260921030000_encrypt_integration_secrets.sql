-- Encrypt integration_credentials at rest (A-159). Production uses pgcrypto;
-- PGlite validation uses the same functions with xor obfuscation when pgcrypto
-- is not installed. Key: Vault `integration_encryption_key`, or the harness
-- GUC app.integration_key.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgcrypto') then
    create extension if not exists pgcrypto;
  end if;
end
$$;

create or replace function integration_encryption_key() returns text
  language plpgsql
  security definer
  set search_path = public, extensions, vault, pg_temp
  as $$
  declare
    k text;
  begin
    if exists (select 1 from pg_extension where extname = 'supabase_vault') then
      select decrypted_secret into k
        from vault.decrypted_secrets
       where name = 'integration_encryption_key';
    end if;
    if k is null or k = '' then
      k := current_setting('app.integration_key', true);
    end if;
    if k is null or k = '' then
      raise exception 'integration encryption key not configured';
    end if;
    return k;
  end
  $$;

create or replace function _integration_xor_obfuscate(data bytea, key text) returns bytea
  language plpgsql
  immutable
  set search_path = public, pg_temp
  as $$
  declare
    key_bytes bytea := convert_to(key, 'UTF8');
    key_len int := length(key_bytes);
    out bytea;
    i int;
  begin
    if key_len = 0 then
      raise exception 'integration encryption key not configured';
    end if;
    out := data;
    for i in 0 .. length(data) - 1 loop
      out := set_byte(
        out,
        i,
        get_byte(data, i) # get_byte(key_bytes, i % key_len)
      );
    end loop;
    return out;
  end
  $$;

create or replace function encrypt_integration_secret(plain jsonb) returns bytea
  language plpgsql
  security definer
  set search_path = public, extensions, vault, pg_temp
  as $$
  declare
    key text := integration_encryption_key();
    payload bytea := convert_to(plain::text, 'UTF8');
  begin
    if exists (select 1 from pg_extension where extname = 'pgcrypto') then
      return pgp_sym_encrypt(plain::text, key);
    end if;
    return _integration_xor_obfuscate(payload, key);
  end
  $$;

create or replace function decrypt_integration_secret(ciphertext bytea) returns jsonb
  language plpgsql
  security definer
  set search_path = public, extensions, vault, pg_temp
  as $$
  declare
    key text := integration_encryption_key();
    plain text;
  begin
    if exists (select 1 from pg_extension where extname = 'pgcrypto') then
      plain := pgp_sym_decrypt(ciphertext, key);
      return plain::jsonb;
    end if;
    return convert_from(_integration_xor_obfuscate(ciphertext, key), 'UTF8')::jsonb;
  end
  $$;

revoke all on function integration_encryption_key() from public;
revoke all on function encrypt_integration_secret(jsonb) from public;
revoke all on function decrypt_integration_secret(bytea) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function encrypt_integration_secret(jsonb) to service_role;
    grant execute on function decrypt_integration_secret(bytea) to service_role;
  end if;
end
$$;

alter table integration_credentials add column if not exists secret_enc bytea;

update integration_credentials
   set secret_enc = encrypt_integration_secret(secret)
 where secret_enc is null;

alter table integration_credentials alter column secret_enc set not null;

alter table integration_credentials drop column secret;

comment on column integration_credentials.secret_enc is
  'Encrypted provider secret (jsonb shape after decrypt). Never log plaintext.';
