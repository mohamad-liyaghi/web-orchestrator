# Real TLS certificate (optional)

Put a real certificate here to replace the self-signed one:

- `fullchain.pem` - the certificate followed by its intermediates
- `privkey.pem` - the private key, readable by uid 101 (the container's `nginx` user)

Everything else in this directory is ignored by git and by the Docker build context. Copy the
files rather than symlinking them (`cp -L`), because a bind mount does not follow links that point
outside it. Restart the container after replacing them: `docker compose restart`.
