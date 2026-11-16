# Security

## Report a vulnerability

Do not open a public issue. Use GitHub's private report: the repository's **Security** tab, then **Report a vulnerability**.

Include:

- what an attacker can do,
- the steps to reproduce it,
- the version or commit, and the operating system.

## What is in scope

- The panel server (port 7878) and the brain (port 7879). Both listen on 127.0.0.1 unless you turn on remote access.
- The remote listener for the iPhone app and the pairing token.
- A self-hosted cloud brain (`brain/deploy/`): the owner token, device join requests, the transport.
- The collector on each device: it is read-only and removes secrets from what it sends.
- The installer (`install.sh`): it checks the SHA-256 of the download.

## Facts that help a review

- There is no hosted service. Data goes only to a server that you run.
- The index and summaries go to your brain. Full transcripts stay on each device.
