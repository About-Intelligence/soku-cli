# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities.

Instead, report them privately via GitHub's
[private vulnerability reporting](https://github.com/About-Intelligence/soku-cli/security/advisories/new),
or email **security@soku.ai**.

Include, where possible:

- A description of the vulnerability and its impact
- Steps to reproduce (a proof of concept if you have one)
- The affected version (`soku --version`)

We aim to acknowledge reports within 3 business days and to provide a remediation
timeline after triage.

## Supported versions

Security fixes are applied to the latest published release on npm
(`@soku-ai/cli`). Older versions are not maintained.

## Handling of credentials

The CLI stores authentication tokens locally (via the OS keychain through
`keytar` when available, otherwise a file-backed store). Never paste tokens into
issues, logs, or pull requests. Rotate a token immediately with
`soku auth logout` followed by `soku auth login` if you believe it was exposed.
