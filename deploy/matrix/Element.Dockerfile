FROM vectorim/element-web:v1.12.31
USER root

# Embedded welcome HTML is sanitized by Element. Load its scoped CSS from the
# trusted application document so no sanitizer policy needs to be changed.
COPY welcome.css /app/wallet-welcome.css
RUN sed -i 's@</head>@<link rel="stylesheet" href="/wallet-welcome.css"></head>@' /app/index.html
USER nginx
