# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in weatherbot-app, please report it responsibly.

**Please do not open a public GitHub issue for security vulnerabilities.**

Preferred: use GitHub's private vulnerability reporting — the **"Report a vulnerability"** button under this repository's **Security** tab. It opens a private channel visible only to the maintainer.

Alternatively, email **andrew.brook@fooblah.org**.

Include as much detail as you can:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

We will acknowledge your report within 48 hours and aim to release a fix within 14 days for critical issues.

## Scope

This policy covers the weatherbot-app frontend and its Firebase Cloud Functions (the Gemini Live token broker and the authenticated MCP tool proxies). The Gemini API key lives only in Firebase Secret Manager and reaches the browser exclusively as a single-use ephemeral token; a report of any path that exposes the long-lived key or lets an unauthorized caller reach the private toolbox is in scope.
