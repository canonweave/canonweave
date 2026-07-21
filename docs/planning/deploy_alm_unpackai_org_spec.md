# Deploy Spec: alm.unpackai.org — Artifact ALM behind Authentik SSO

**Owner:** Sam (exportdesk.product_owner)
**Executor:** Max
**Paperclip:** UNP-51 (under UNP-48, unpackai.io Operations, interactive, high)
**Status:** Infrastructure complete — pending Aidar acceptance test (AC-3/AC-4/AC-5)

**Completed 2026-06-24:** DNS, TLS, Caddy block, Authentik (already configured), Infisical secrets. Live at https://alm.unpackai.org:8443

---

## What this deploys

The Artifact Recipe Builder web UI — a Node.js 22 + Postgres 16 app that manages product artifact traceability for the iMaoKe Product Lifecycle. It is already running on the Shanghai VPS. This spec makes it reachable at `https://alm.unpackai.org:8443` behind Authentik SSO, same pattern as `paperclip.unpackai.org:8443`.

---

## Current state (before this task)

| Item | State |
|---|---|
| App process | Running on VPS via Docker Compose |
| App port | `127.0.0.1:8792` and `100.67.6.87:8792` (Tailscale) |
| App code on Mac | `~/Documents/ai_master/projects/imaoke/harness/trace/app/` |
| Entry point | `server.pg.mjs` |
| Database | Postgres 16, db `alm`, user `alm`, password in `PGPASSWORD` env |
| Docker volume | `almdb` (data persists across restarts) |
| Mac tunnel | `http://127.0.0.1:8792` reachable on Mac via SSH tunnel |
| DNS | Not yet created |
| TLS cert | Not yet issued |
| Caddy block | Not yet created |
| Authentik config | Not yet created |
| Infisical secret | Not yet registered |

---

## Step 0 — Verify live state on VPS

SSH to `root@101.132.43.192` and confirm before doing anything else:

```bash
# Confirm Docker Compose is up
docker ps | grep -E "alm|8792"

# Confirm port is listening
ss -tlnp | grep 8792

# Confirm Postgres has data
docker exec <alm_db_container> psql -U alm -d alm -c "\dt"
```

If the compose stack is not running, find the working directory (`docker inspect`) and start it. Do not proceed until port 8792 responds.

---

## Step 1 — DNS (Namecheap)

Add an A record at Namecheap for the `unpackai.org` zone:

| Host | Type | Value | TTL |
|---|---|---|---|
| `alm` | A | `101.132.43.192` | 300 |

This is a **Namecheap** zone, not Cloudflare. Log in at namecheap.com, go to Domain List → `unpackai.org` → Advanced DNS, add the record.

DNS propagation: typically 2–10 minutes with TTL 300. Verify with `dig alm.unpackai.org @8.8.8.8 +short` before issuing the TLS cert.

---

## Step 2 — TLS certificate (acme.sh DNS-01, LE EC)

Same pattern as all other `*.unpackai.org` subdomains. Aliyun blocks port 80, so DNS-01 is mandatory.

On the VPS (`root@101.132.43.192`):

```bash
# Issue EC cert via DNS-01 (add TXT record manually at Namecheap when prompted)
acme.sh --issue --dns dns_manual -d alm.unpackai.org --keylength ec-256

# After TXT record is verified and cert issued, install it
acme.sh --install-cert -d alm.unpackai.org --ecc \
  --cert-file      /etc/caddy/alm.unpackai.org.cer \
  --key-file       /etc/caddy/alm.unpackai.org.key \
  --fullchain-file /etc/caddy/alm.unpackai.org.fullchain.cer \
  --reloadcmd      'systemctl reload caddy'

# Fix ownership
chown caddy:caddy /etc/caddy/alm.unpackai.org.*
```

Verify cert is installed: `ls -la /etc/caddy/alm.unpackai.org*`

---

## Step 3 — Authentik: Provider + Application

Log in to `https://auth.unpackai.org:8443` as admin.

### 3a. Create Provider

Admin → Applications → Providers → Create
Type: **Proxy Provider** (Forward auth — single application)

| Field | Value |
|---|---|
| Name | `alm-unpackai-org` |
| Authentication flow | `default-authentication-flow` |
| Authorization flow | `default-provider-authorization-implicit-consent` |
| External host | `https://alm.unpackai.org:8443` |
| Mode | Forward auth (single application) |

Save and note the Provider ID.

### 3b. Create Application

Admin → Applications → Applications → Create

| Field | Value |
|---|---|
| Name | `Artifact ALM` |
| Slug | `alm` |
| Provider | `alm-unpackai-org` (the one just created) |
| Launch URL | `https://alm.unpackai.org:8443` |

Save.

### 3c. Assign to Outpost

Admin → Applications → Outposts → find the existing outpost (the one serving `paperclip.unpackai.org`) → Edit → add `Artifact ALM` to the selected applications → Save.

Wait ~30 seconds for the outpost to pick up the new application.

---

## Step 4 — Caddy configuration (additive, with backup)

On the VPS:

```bash
# Backup first
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
```

Append the following block to `/etc/caddy/Caddyfile` (do not modify existing blocks):

```caddyfile
alm.unpackai.org:8443 {
    tls /etc/caddy/alm.unpackai.org.fullchain.cer /etc/caddy/alm.unpackai.org.key

    handle /outpost.goauthentik.io/* {
        reverse_proxy http://127.0.0.1:9000
    }

    handle {
        request_header X-Original-URL "https://alm.unpackai.org:8443{uri}"
        forward_auth http://127.0.0.1:9000 {
            uri /outpost.goauthentik.io/auth/caddy
            copy_headers X-Authentik-Username X-Authentik-Email X-Authentik-Groups X-Authentik-Uid
        }
        reverse_proxy http://127.0.0.1:8792
    }

    log {
        output file /var/log/caddy/alm.access.log {
            roll_size 10mb
            roll_keep 3
        }
        format console
    }
}
```

Validate and reload:

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

If validate fails, restore backup and diagnose before touching the live Caddyfile.

---

## Step 5 — Infisical: register PG password

Register the Postgres password so it is discoverable by agents and not only in the VPS environment.

Secret name: `ALM_PGPASSWORD`
Project: `AI Workforce`, env: `prod`

Read the current value from VPS first:

```bash
ssh root@101.132.43.192 "docker exec \$(docker ps --filter name=alm -q | head -1) printenv PGPASSWORD"
```

Then store in Infisical from Mac (plain curl is blocked by Aliyun TLS filter — use Node helper):

```bash
node ~/Documents/ai_master/projects/workforce/scripts/infisical_set_secret.js ALM_PGPASSWORD <value>

# Verify read-back
node ~/Documents/ai_master/projects/workforce/scripts/infisical_get_secret.js ALM_PGPASSWORD
```

---

## Step 6 — End-to-end acceptance check

Run these checks in order. Each must pass before calling the task done.

### 6a. HTTPS + Authentik gate

```bash
curl -I https://alm.unpackai.org:8443/
```

Expected: `302` redirect to `https://auth.unpackai.org:8443/...` (Authentik login).
A `200` with app HTML means forward_auth is not wired — recheck Step 3c and Step 4.

### 6b. Authenticated access

Open `https://alm.unpackai.org:8443/` in a browser. Log in via Authentik (Google OAuth). Expected: the Artifact ALM UI loads.

### 6c. Persistence

Make an edit in the UI. Reload the page. The change must still be present — proves Postgres writes persist.

### 6d. Mobile

Load `https://alm.unpackai.org:8443/` on a phone browser. Page must render and be usable.

### 6e. Existing services unaffected

```bash
curl -I https://paperclip.unpackai.org:8443/
curl -I https://vault.unpackai.org:8443/api/status
curl -I https://auth.unpackai.org:8443/
```

All must return their normal responses. If any break, restore the Caddyfile backup.

---

## Acceptance criteria (maps to UNP-51)

| # | Criterion | Evidence |
|---|---|---|
| AC-1 | `https://alm.unpackai.org:8443` reachable with valid TLS | `curl -I` shows TLS handshake + 302 or 200 |
| AC-2 | Authentik gate active — unauthenticated request redirects to login | `curl -I` returns 302 to `auth.unpackai.org` |
| AC-3 | Authenticated user can load the ALM UI | Browser test post-login |
| AC-4 | Edits persist across page reloads | Write → reload → verify |
| AC-5 | Mobile renders and is usable | Phone browser test |
| AC-6 | `paperclip.unpackai.org`, `vault.unpackai.org`, `auth.unpackai.org` return normal responses | curl checks post-deploy |

---

## Rollback

If Caddy breaks after the new block is added:

```bash
cp /etc/caddy/Caddyfile.bak-<timestamp> /etc/caddy/Caddyfile
systemctl reload caddy
```

The ALM app and Postgres are unaffected by a Caddy rollback — they keep running on port 8792.

---

## Open question for Aidar

Step 1 (DNS) requires manual Namecheap login. If you want agents to handle DNS automatically: say the word and I will file a small separate task — "Grant Max Namecheap API access: key + IP whitelisting stored in Infisical." After that, DNS records for all future subdomains can be automated.
