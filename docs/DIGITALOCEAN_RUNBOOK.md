# First launch on DigitalOcean

Step-by-step commands for the System Owner to put the demo online at
`https://cost-engine.ichiaho.dev`. [DEPLOYMENT.md](DEPLOYMENT.md) holds the full
safety contract; this page applies it to one host. Nothing here runs automatically,
and CI never deploys.

```text
Browser → Cloud Firewall → Caddy (HTTPS) → Backend → PostgreSQL
                             on one 2 GiB Droplet, in Docker Compose
```

| Item | Choice | Cost |
|---|---|---|
| Server | Basic Droplet, 2 GiB, 1 vCPU, Ubuntu 24.04, Singapore (`sgp1`) | [$12/month](https://www.digitalocean.com/pricing/droplets) |
| Reserved IP | Assigned to the Droplet | [Free while assigned; $5/month if left unassigned](https://docs.digitalocean.com/products/networking/reserved-ips/details/pricing/) |
| Cloud Firewall | Rules below | [Free](https://docs.digitalocean.com/products/networking/firewalls/) |
| Domain | `ichiaho.dev` from Cloudflare Registrar, DNS only | Shown at checkout |

[A powered-off Droplet is still billed](https://docs.digitalocean.com/products/droplets/details/pricing/).
Only destroying it stops the charge. Check the price on the create page before confirming.

## 1. Account

1. Turn on two-factor authentication for the DigitalOcean account.
2. In [Billing → Spend alerts](https://docs.digitalocean.com/platform/billing/spend-alerts/), create a monthly alert of $15.
   It only notifies you; it is not a spending cap.
3. Buy `ichiaho.dev`. The `.dev` domains are HTTPS-only in browsers; Caddy handles that.

## 2. Droplet

Create your SSH key in WSL (or any Linux or macOS shell), and keep the private half on your computer:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/cost-engine-droplet
cat ~/.ssh/cost-engine-droplet.pub
```

DigitalOcean console → **Create → Droplets**:

- Region: Singapore (`SGP1`).
- Image: OS, Ubuntu 24.04 (LTS) x64.
- Size: Basic, Regular CPU, $12, 2 GiB, 1 vCPU.
- Authentication: **SSH key**, adding the `.pub` text. Do not choose Password.
- Public IPv6 address: leave cleared. [It is off by default](https://docs.digitalocean.com/products/droplets/how-to/create/).
- Automatic backups: off.

Then:

1. **Networking → Reserved IPs**: assign a reserved IPv4 address to the Droplet. This is `SERVER_IP` below.
2. **Networking → Firewalls → Create Firewall**, and apply it to the Droplet. It must end up exactly like this:

| Direction | Protocol | Port | Source or destination |
|---|---|---|---|
| Inbound | TCP | 22 | Your IP only |
| Inbound | TCP | 80 | All IPv4 (certificate issuance and redirect) |
| Inbound | TCP | 443 | All IPv4 |
| Inbound | UDP | 443 | All IPv4 (HTTP/3) |
| Outbound | TCP | All | All IPv4 |
| Outbound | UDP | All | All IPv4 |
| Outbound | ICMP | n/a | All IPv4 |

[With no outbound rule, no outbound traffic is permitted](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/),
which would break `apt`, image pulls and certificate issuance.

Do not add 3000 or 5432. Use this firewall, not `ufw`:
[Docker's published ports bypass `ufw`](https://docs.docker.com/engine/install/ubuntu/).
If your home IP changes, update the port 22 rule here.

## 3. DNS

In Cloudflare DNS, add an `A` record: name `cost-engine`, value the reserved IP, proxy
status **DNS only** (grey cloud). Add no `AAAA` record. The backend trusts Caddy's
socket peer, so a Cloudflare proxy in front would break per-address rate limits.

Wait until this returns the reserved IP. Certificate issuance needs it:

```sh
nslookup cost-engine.ichiaho.dev 1.1.1.1
```

## 4. Host

The containers run as UID 1000, so the host needs a matching user. A new Droplet starts
with `root` only. Connect with `ssh -i ~/.ssh/cost-engine-droplet root@SERVER_IP`, then:

```sh
adduser ubuntu                 # set a password and keep it in your password manager
usermod -aG sudo ubuntu
id -u ubuntu                   # must print 1000; stop here if it does not
install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
install -m 600 -o ubuntu -g ubuntu /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys
```

Keep that session open. In a new terminal, connect with
`ssh -i ~/.ssh/cost-engine-droplet ubuntu@SERVER_IP`. Only after that works, turn off root login:

```sh
echo 'PermitRootLogin no' | sudo tee /etc/ssh/sshd_config.d/00-no-root.conf
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -iE '^(passwordauthentication|permitrootlogin)'   # both must print "no"
```

Then, as `ubuntu`:

```sh
sudo apt update && sudo apt -y upgrade

# Headroom for image builds on a 2 GiB Droplet.
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
killed for lack of memory, check that swap is on with `free -h`. This plan has one vCPU, so the
build may be slow. If you reconnect later, run the `export` line again.

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
curl -m 5 http://SERVER_IP:3000                                             # must fail
curl -m 5 http://SERVER_IP:5432                                             # must fail
```

In a browser, with the console open:

- The page loads over HTTPS, with no CSP errors.
- Run each of the four scenarios and manual mode. Then run `Lost response` on a phone.
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

**Take the demo down for good.** Destroy the Droplet, release the reserved IP (it bills while unassigned),
delete the firewall, remove the DNS record, and delete the spend alert if you no longer need it.

## What is not proved yet

CI rehearses this install order with Docker and a local certificate. A real certificate
from public DNS, building on a 2 GiB one-vCPU Droplet, and the Cloud Firewall blocking published ports
3000 and 5432 are first proved by this launch. The last one is what the two `curl` checks in step 8 test.

## What this launch does not claim

- No backup, and no RPO or RTO target. Demo data is disposable ([ADR-0021](adr/0021-remove-recovery-tooling.md)).
- One Droplet: no high availability, and basic rate limits rather than DDoS protection.
- The executor is simulated. There is no real Airflow and no financial calculation.
