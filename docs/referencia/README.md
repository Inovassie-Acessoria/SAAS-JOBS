# Referência de design — h2bapply

O front `public/h2b/` é a transcrição do sistema de referência (h2bapply)
que o usuário colou no chat em 2026-09-11. O arquivo original (`h2bapply.txt`)
**não está neste repositório** — ele chegou só pela conversa. Se quiser
guardar a cópia para consulta, coloque-o nesta pasta.

O que foi copiado: design (tokens, tema escuro, header, sidebar, bottom nav,
drawer, cards, modais, toasts), telas de início, vagas, envio manual, envio
automático (assistente + painel), histórico, pesquisa, logs, perfil
(Eu / Currículos / Números), editor de documentos e modelos, notificações,
notícias, configurações, onboarding, tour, PWA.

O que ficou de fora, por decisão do usuário ("uso pessoal"): assinatura/planos,
ranking, diamantes/PIX, cadastro multiusuário, painel admin, termos de uso,
depoimentos, promoções de criadores, parceiro FalaFina, chat Gemini.

Comportamento e back-end são reimplementações sobre o Seasonal Jobs existente
(`/api/seasonal/*`), não cópia: o `app.js` do sistema original nunca esteve
disponível.
