# Add this to your .do/app.yaml under the services section

services:
- name: whatsapp-lims-api
  # ... existing config ...
  
  # Add volume for WhatsApp session persistence
  volumes:
  - name: whatsapp-sessions
    size: 2GiB
    mount_path: /app/NodeBackend/.local
