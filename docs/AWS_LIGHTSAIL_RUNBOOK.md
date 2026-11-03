# First launch on AWS Lightsail

Step-by-step commands for the System Owner to put the demo online at
`https://cost-engine.ichiaho.dev`. [DEPLOYMENT.md](DEPLOYMENT.md) holds the full
safety contract; this page applies it to one host. Nothing here runs automatically,
and CI never deploys.

```text
Browser → Lightsail firewall → Caddy (HTTPS) → Backend → PostgreSQL
                                 on one 2 GB instance, in Docker Compose
```

| Item | Choice | Cost |
|---|---|---|
| Server | Lightsail Linux, general purpose, public IPv4, 2 GB, Tokyo | [$12/month](https://aws.amazon.com/lightsail/pricing) |
| Static IP | Attached to the instance | Included |
| Domain | `ichiaho.dev` from Cloudflare Registrar, DNS only | Shown at checkout |

Lightsail's [short-term free trials have ended for new customers, and a stopped
instance is still billed](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html).
Only deleting it stops the charge.

## 1. Account

1. Turn on MFA for the AWS root user.
2. In AWS Budgets, create a monthly cost budget of $15 with an email alert.
3. Buy `ichiaho.dev`. The `.dev` domains are HTTPS-only in browsers; Caddy handles that.

## 2. Instance

Create your SSH key in WSL (or any Linux or macOS shell), and keep the private half on your computer:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/cost-engine-lightsail
cat ~/.ssh/cost-engine-lightsail.pub
```

Upload the `.pub` text in Lightsail → **Account → SSH keys**, with Tokyo selected.

A new account's instance quota can be 0, which blocks creating an instance. If the create page says so, open
Service Quotas → Amazon Lightsail → **Instances (vCPU)** in Tokyo and request an increase. The form's minimum was 20 when
this was written. It costs nothing, and only instances bill. Approval can take a while.

Lightsail console → **Create instance**:

- Region: Tokyo (`ap-northeast-1`).
- Blueprint: Linux, OS only, Ubuntu 24.04 LTS.
- SSH key: the one you uploaded.
- Network type: dual-stack (it has the public IPv4 address).
- Plan: General purpose, $12, 2 GB.
- Automatic snapshots: off.

Then, on the instance:

1. **Networking → Create static IP** and attach it.
2. **Networking → IPv6 networking**: [turn it off](https://docs.aws.amazon.com/lightsail/latest/userguide/disable-ipv6.html).
   The [IPv4 and IPv6 firewalls are separate](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html),
   so leaving it on would keep SSH open on IPv6.
3. **Networking → IPv4 firewall** must end up exactly like this:

| Protocol | Port | Source |
|---|---|---|
| SSH (TCP) | 22 | Your IP only, with **Allow Lightsail browser SSH** ticked |
| TCP | 80 | Any (certificate issuance and redirect) |
| TCP | 443 | Any |
| UDP | 443 | Any (HTTP/3) |

Do not add 3000 or 5432. Use this firewall, not `ufw`:
[Docker's published ports bypass `ufw`](https://docs.docker.com/engine/install/ubuntu/).
If your home IP changes, use the console's browser SSH to get in, or update the rule here.

## 3. DNS

In Cloudflare DNS, add an `A` record: name `cost-engine`, value the static IP, proxy
status **DNS only** (grey cloud). Add no `AAAA` record. The backend trusts Caddy's
socket peer, so a Cloudflare proxy in front would break per-address rate limits.

Wait until this returns the static IP. Certificate issuance needs it:

```sh
nslookup cost-engine.ichiaho.dev 1.1.1.1
```

## 4. Host

Connect with `ssh -i ~/.ssh/cost-engine-lightsail ubuntu@STATIC_IP`, then:

```sh
sudo apt update && sudo apt -y upgrade
sudo sshd -T | grep -i '^passwordauthentication'   # must print "no"
id -u                                              # must print 1000, the containers' user

# Headroom for image builds on a 2 GB instance.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Install Docker from [its official repository](https://docs.docker.com/engine/install/ubuntu/):

```sh
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu
```

Log out and back in so the group applies, then check `docker compose version`.

## 5. Code, configuration and secrets

```sh
git clone https://github.com/good74152/cost-engine-orchestration-platform.git ~/cost-engine
sudo install -d -o ubuntu -g ubuntu -m 700 /opt/cost-engine-demo /opt/cost-engine-demo/secrets

( cd /opt/cost-engine-demo/secrets && umask 077
  password=$(openssl rand -hex 24)
  printf '%s' "$password" > postgres_password
  printf 'postgres://demo_owner:%s@database:5432/cost_engine_demo' "$password" > database_url
  openssl rand -hex 32 | tr -d '\n' > proxy_secret
  chmod 400 postgres_password database_url proxy_secret )

cd ~/cost-engine
( umask 077; cat > /opt/cost-engine-demo/compose.env <<EOF
DEPLOYMENT_VERSION=$(git rev-parse --short=12 HEAD)
DEMO_PUBLIC_ORIGIN=https://cost-engine.ichiaho.dev
ACME_EMAIL=REPLACE_WITH_YOUR_EMAIL
DEMO_SECRETS_DIR=/opt/cost-engine-demo/secrets
EOF
)
nano /opt/cost-engine-demo/compose.env   # set ACME_EMAIL
```

Never paste these files into a chat, an issue or a log. Limits not set here use the
defaults in [DEPLOYMENT.md](DEPLOYMENT.md#configuration).

## 6. Build

Build once in the open first, because `deploy.sh` hides build output. If the build is
killed for lack of memory, check that swap is on with `free -h`. If you reconnect later,
run the `export` line again.

```sh
export DEMO_DEPLOY_ENV=/opt/cost-engine-demo/compose.env
docker compose --env-file "$DEMO_DEPLOY_ENV" -f deploy/compose.yaml config --quiet
docker compose --env-file "$DEMO_DEPLOY_ENV" -f deploy/compose.yaml \
  --profile operations --profile public-web build backend web operator
```

## 7. First install

Run these one at a time and stop at the first failure. This is the order the
deployment rehearsal runs in CI.

```sh
sh deploy/scripts/deploy.sh                 # Web closed; only the database starts
sh deploy/scripts/operate.sh migrate-up
sh deploy/scripts/operate.sh seed-six-domain
sh deploy/scripts/start.sh                  # Backend ready; Web still closed
```

If the database is wrong or lost during first install, the simplest fix is a fresh one. The demo holds no data worth keeping.

## 8. Open and check

Repeat the `nslookup` from step 3 first. Repeated failed certificate requests can hit
the certificate authority's rate limits.

```sh
sh deploy/scripts/open-web.sh
```

From your own computer:

```sh
ORIGIN=https://cost-engine.ichiaho.dev
curl -sI "$ORIGIN" | grep -iE '^(HTTP|strict-transport-security|content-security-policy)'
curl -s -o /dev/null -w '%{http_code}\n' "$ORIGIN/health"                   # 404
curl -s -o /dev/null -w '%{http_code}\n' "$ORIGIN/demo/workflow-templates"  # 401
curl -m 5 http://STATIC_IP:3000                                             # must fail
curl -m 5 http://STATIC_IP:5432                                             # must fail
```

In a browser, with the console open:

- The page loads over HTTPS, with no CSP errors.
- Run each of the four scenarios. Then run `Lost response` on a phone.
- Switch to 繁體中文 and back.
- Clear the demo data, then run `Happy path` again.

If anything fails, close the site right away. Data and configuration stay:

```sh
sh deploy/scripts/close-web.sh
```

Then add an external uptime check on the public URL. The reason is in the next section.

## Later operations

Run all of these from `~/cost-engine` with `DEMO_DEPLOY_ENV` exported.
Avoid `docker compose down -v` and `docker volume prune`: both delete the database, and you'd have to migrate and seed again.

**After a reboot.** The site stays down until you open it. This is deliberate: a daemon
restart must not reopen a closed site. Backend restart also ends existing demo sessions,
because the simulated executor's memory is gone.

```sh
sh deploy/scripts/start.sh
sh deploy/scripts/open-web.sh
```

**Release a new version.** Expect a short outage.

```sh
git fetch origin && git checkout COMMIT
sed -i "s/^DEPLOYMENT_VERSION=.*/DEPLOYMENT_VERSION=$(git rev-parse --short=12 HEAD)/" "$DEMO_DEPLOY_ENV"
docker compose --env-file "$DEMO_DEPLOY_ENV" -f deploy/compose.yaml \
  --profile operations --profile public-web build backend web operator
sh deploy/scripts/deploy.sh
# Only if the release adds migrations:
#   sh deploy/scripts/operate.sh migrate-up
sh deploy/scripts/start.sh
sh deploy/scripts/open-web.sh
```

**Take the demo down for good.** Delete the instance and release the static IP in the
Lightsail console, remove the DNS record, and delete the budget if you no longer need it.

## What is not proved yet

CI rehearses this install order with Docker and a local certificate. A real certificate
from public DNS, and building on a 2 GB instance, are first proved by this launch.

## What this launch does not claim

- No backup, and no RPO or RTO target. Demo data is disposable ([ADR-0021](adr/0021-remove-recovery-tooling.md)).
- One instance: no high availability, and basic rate limits rather than DDoS protection.
- The executor is simulated. There is no real Airflow and no financial calculation.
