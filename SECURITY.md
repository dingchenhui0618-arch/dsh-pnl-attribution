# Security

## Scope

`dsh-pnl-attribution` reads a local holdings file and calls public Tencent quote endpoints. It does **not** handle broker logins, cookies, tokens, order placement, or account credentials.

## Reporting

If you find a vulnerability, open a private security advisory on the GitHub repository or contact the maintainer through the repository's issue tracker. Please do not include real holdings, account data, or credentials in a public issue.

## Local data

- The plugin reads only `holdingsPath` (default `$DSH_HOME/pnl-attribution/holdings.csv`) and never writes it.
- The host exposes `/dsh-pnl-attribution/state` through the DSH web server, so it inherits the server's authentication. Do not expose the DSH web port to an untrusted network.
- Quote requests are outbound HTTPS to `qt.gtimg.cn` and `web.ifzq.gtimg.cn`; no credentials are attached.

## Supported versions

Security fixes target the latest `0.1.x` release and DSH `0.2.x`.
