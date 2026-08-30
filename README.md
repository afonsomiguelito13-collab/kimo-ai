# Kimo

Um chatbot completo sobre o gateway [xKiro](https://xkiro.com) — GLM-5.3 Flash
por padrão, mais de 100 modelos disponíveis, streaming token a token, visão,
controle de raciocínio e busca na web. **Zero dependências**: só Node 18+.

![sem dependências](https://img.shields.io/badge/deps-0-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A518-blue)
![licença](https://img.shields.io/badge/license-MIT-lightgrey)

---

## O que tem

- **105 modelos** — OpenAI, Anthropic, Google, DeepSeek, Qwen, Z-AI, Moonshot,
  xAI, Mistral e outros, com logo, preço e limites de cada um
- **Seletor em dois painéis** — lista à esquerda, detalhes à direita; no celular
  vira duas páginas
- **Controle de raciocínio por modelo** — os níveis vêm do catálogo ao vivo, então
  cada modelo mostra só os que aceita
- **Streaming real** — SSE token a token, com botão de parar que cancela a
  chamada upstream e interrompe a cobrança
- **Visão** — cole ou anexe imagens nos modelos que suportam
- **Busca na web** opcional, com citações numeradas
- **Markdown** com destaque de código e botão de copiar por bloco
- **Controle de gastos** — orçamento e contador de consumo estimado
- **Conversas salvas** no navegador, sem conta e sem servidor nosso

---

## Rodar localmente

```bash
git clone https://github.com/SEU_USUARIO/kimo.git ~/kimo
cd ~/kimo
echo 'XKIRO_API_KEY=sk-xt-suachave' > .env
node server.js
```

Abra <http://localhost:3000>.

A chave sai de <https://xkiro.com/dashboard/api/keys>. Sem ela o app ainda abre e
lista os modelos — só não conversa. Dá para colar a chave na tela de Ajustes em
vez de usar o `.env`; nesse caso ela fica no navegador.

### No Termux (Android)

```bash
pkg install nodejs git -y
git clone https://github.com/SEU_USUARIO/kimo.git ~/kimo
cd ~/kimo && node server.js
```

Depois abra `http://localhost:3000` no Chrome. Vale ativar o wakelock do Termux
para o Android não matar o processo em segundo plano.

---

## Publicar online

Veja **[DEPLOY.md](DEPLOY.md)** para o passo a passo no Render.

Um aviso que economiza tempo: **não funciona como site estático**. A API da xKiro
não envia headers CORS, então o navegador é bloqueado ao tentar chamá-la direto.
O `server.js` é a ponte que resolve isso — e é ele que anexa a chave, que assim
nunca chega ao navegador.

---

## Variáveis de ambiente

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `3000` | Porta HTTP. Plataformas de deploy injetam a delas. |
| `HOST` | `0.0.0.0` | Interface de escuta. |
| `XKIRO_API_KEY` | — | Sua chave. Se vazia, o app pede na tela de Ajustes. |
| `XKIRO_BASE_URL` | `https://api.xkiro.com/v1` | Para apontar a um proxy próprio. |

---

## Como funciona

```
navegador  ──►  server.js  ──►  api.xkiro.com
           ◄──  (SSE)     ◄──
```

O servidor é um único arquivo sem dependências. Ele serve os estáticos e expõe
quatro rotas:

| Rota | O que faz |
|---|---|
| `GET /api/health` | Sinal de vida, usado pelo healthcheck |
| `GET /api/verify` | Diagnostica a chave e diz exatamente o que está errado |
| `GET /api/models` | Catálogo, com cache de 5 min e fallback para o cache velho |
| `POST /api/chat` | Repassa o chat em SSE |

Sobre o `/api/chat`, vale registrar o porquê de algumas decisões:

- **Sempre força `stream: true`.** Requisições não-streaming da xKiro são cortadas
  em 95 segundos, o que quebra respostas longas.
- **Injeta `stream_options.include_usage`**, senão o consumo de tokens nunca chega.
- **Omite `reasoning_effort` quando é `"auto"`** — porque na xKiro omitir o campo
  não é o mesmo que enviar `"none"`; omitir usa o padrão do modelo, `"none"`
  desliga de fato.
- **Aborta o upstream** quando o cliente desconecta, para não continuar pagando.
- **Rejeita IDs sem prefixo de fabricante** com 400, já que a xKiro devolveria um
  404 confuso.

---

## Privacidade

Sem cookies, sem analytics, sem telemetria, sem scripts de terceiros, sem contas.
As conversas ficam no `localStorage` do seu navegador. As únicas chamadas externas
são para a xKiro e — se você ligar a busca — DuckDuckGo e Wikipédia.

Detalhes em `/policies.html` no app rodando.

---

## Licença

MIT.
