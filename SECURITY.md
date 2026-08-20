# Security Policy

The Rayls Network team takes the security of the Rayls stack and its users seriously.
We are grateful to the security researchers and operators who help keep the project safe.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or Discord.**

Report vulnerabilities privately through **GitHub's private vulnerability reporting**:

1. Open the [Security tab](https://github.com/raylsnetwork/rayls-sovereign-tests-automation/security) of this repository.
2. Click **"Report a vulnerability"** and complete the advisory form.

This opens a channel visible only to the maintainers. If you are unable to use GitHub's
private reporting, contact a maintainer via the
[Rayls Network Discord](https://discord.com/channels/1252990258514235544/1252996402942836857)
to arrange a secure disclosure channel — do **not** include vulnerability details in public messages.

This repository is the Rayls end-to-end test suite. If you find a security issue in the **tests
themselves** (for example, a committed real secret or an insecure example), report it here.
Vulnerabilities in the Rayls **software under test** should be reported against the relevant
component's repository, following that repository's `SECURITY.md`.

## Response Process

1. We will acknowledge receipt of your report within **48 hours**.
2. We will provide an initial assessment within **5 business days**.
3. We will keep you informed of our progress as we investigate and resolve the issue.
4. Once resolved, we will notify you and coordinate public disclosure timing.

## Disclosure Policy

- All vulnerability reports and associated communications are treated as confidential.
- We kindly ask that you **not publicly disclose** any details until we have released a fix and
  agreed on a disclosure timeline.

## Supported Versions

The project is under active development. Security fixes are released against the **latest
release**; operators are strongly encouraged to always run the latest version.
