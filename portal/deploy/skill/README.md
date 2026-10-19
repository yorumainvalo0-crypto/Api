# Deployment skills

Mounted into LibreChat at `/app/skill` (see `docker-compose.override.yml`). Each folder is one skill
that Claude can load on demand; files are created with the code runner and saved to `/mnt/data`,
where LibreChat picks them up as downloads.
