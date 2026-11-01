# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report vulnerabilities privately through GitHub's
"Report a vulnerability" button on the repository's Security tab. Include steps to reproduce,
affected versions and the impact you believe it has. We aim to acknowledge reports within
3 working days and to ship a fix for confirmed high-severity issues within 14 days.

## Supported versions

Security fixes are made on the latest release.

## Hardening checklist for operators

- Set a random `APP_SECRET` of 32+ characters (startup refuses insecure values in production).
- Serve Folio over HTTPS; cookies are marked `Secure` automatically for an https `PUBLIC_URL`.
- Set `TRUST_PROXY` to your load balancer's network only, so rate limits can't be bypassed.
- Restrict sign-up (`SIGNUP_MODE=domain|invite`) for internal deployments.
- Keep the database and object storage private to the cluster; enable bucket versioning and
  database backups (see `docs/deployment.md`).

The application's security design (authentication, CSRF, sanitising, upload checks, SSRF
protection, secret storage) is described in `docs/architecture.md`.
