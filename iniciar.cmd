@echo off
REM H2 Dream — inicia o sistema nesta máquina e abre o app no navegador.
REM Primeiro uso: garante dependências e o .env (com chave de cifra nova).
cd /d "%~dp0"

if not exist node_modules (
  echo Instalando dependencias...
  call npm ci --no-audit --no-fund
)

if not exist .env (
  echo Criando .env a partir do .env.example...
  copy /y .env.example .env >nul
  for /f %%k in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do (
    node -e "const fs=require('fs');let s=fs.readFileSync('.env','utf8');s=s.replace(/^APP_ENCRYPTION_KEY=.*$/m,'APP_ENCRYPTION_KEY=%%k').replace(/^MAX_SEASONAL_APPLICATION_EMAILS_PER_DAY=.*$/m,'MAX_SEASONAL_APPLICATION_EMAILS_PER_DAY=300');fs.writeFileSync('.env',s)"
  )
)

start "" http://localhost:3000/h2b/
node server.js
