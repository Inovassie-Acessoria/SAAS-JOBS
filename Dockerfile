# Job Intelligence Platform
#
# Node 22+ é obrigatório: a aplicação usa `node:sqlite`, nativo a partir dessa
# versão. Sem etapa de build — o front-end é JavaScript servido estaticamente.

FROM node:22-alpine

# Ferramentas mínimas para health check e diagnóstico dentro do container.
RUN apk add --no-cache tini curl

# Chromium para a descoberta por navegador (§46).
#
# É usado APENAS pelo Indeed, que não publica API consumível por este backend.
# Gupy usa o MCP oficial e Seasonal usa o feed do DOL — os dois funcionam sem
# navegador nenhum. Se você remover esta camada para ter uma imagem menor, o
# sistema continua de pé e só o Indeed reporta indisponível, com explicação.
#
# `puppeteer-core` não baixa navegador; usa este, apontado por CHROME_PATH.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      font-noto \
      font-noto-emoji

WORKDIR /app

# Camada de dependências separada, para aproveitar o cache entre builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Diretórios que precisam existir e pertencer ao usuário sem privilégio.
# `private_uploads` fica FORA de qualquer caminho servido estaticamente.
RUN mkdir -p /app/data /app/private_uploads/resumes /app/private_uploads/documents /app/private_uploads/.secrets \
 && chmod 700 /app/private_uploads/.secrets \
 && chown -R node:node /app/data /app/private_uploads

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    # Onde o Alpine instala o Chromium. O adaptador procura em vários lugares,
    # mas apontar explicitamente evita depender da ordem dessa busca.
    CHROME_PATH=/usr/bin/chromium-browser \
    # Dentro do container não há tela: a navegação é sempre invisível.
    BROWSER_HEADLESS=true \
    # O sandbox do Chromium exige privilégios que este container não tem — ele
    # roda como usuário sem privilégio, que é a troca correta. Sem esta flag o
    # navegador nem inicia.
    BROWSER_NO_SANDBOX=true \
    # No servidor não existe o Chrome pessoal do usuário; o perfil é sempre o
    # dedicado, gravado no volume persistente.
    CHROME_PROFILE_MODE=dedicated

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/health/live || exit 1

# tini como PID 1 garante encerramento limpo e ausência de processos zumbis.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
