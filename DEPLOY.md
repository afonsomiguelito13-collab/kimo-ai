# Publicar o Kimo no Render

O Kimo precisa de um servidor Node — não dá para hospedar como site estático.
A API da xKiro não envia headers CORS, então o navegador é bloqueado ao tentar
falar com ela diretamente. O `server.js` existe justamente para ser essa ponte,
e é ele que anexa a sua chave, que assim nunca chega ao navegador.

---

## 1. Subir para o GitHub

No Termux, dentro da pasta do app:

```bash
cd ~/kimo
git init
git add .
git commit -m "Kimo"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/kimo.git
git push -u origin main
```

Se o push pedir senha, o GitHub não aceita mais a senha da conta — gere um token
em **Settings → Developer settings → Personal access tokens → Fine-grained**,
marque *Contents: Read and write*, e use o token como senha.

O `.gitignore` já impede que o `.env` (sua chave) vá para o repositório.
Confirme com `git status` antes do commit: o `.env` não deve aparecer na lista.

---

## 2. Criar o serviço no Render

1. Em <https://dashboard.render.com> → **New** → **Web Service**
2. Conecte a conta do GitHub e escolha o repositório `kimo`
3. Preencha:

   | Campo | Valor |
   |---|---|
   | Language | `Node` |
   | Build Command | *(deixe vazio)* |
   | Start Command | `node server.js` |
   | Instance Type | `Free` |

4. Em **Environment Variables**, adicione:

   | Key | Value |
   |---|---|
   | `XKIRO_API_KEY` | `sk-xt-...` (sua chave) |

5. **Create Web Service**

O repositório já traz um `render.yaml`, então o Render também consegue ler essa
configuração sozinho via **Blueprint** se você preferir.

Não defina `PORT` — o Render injeta a porta dele, e o `server.js` já a respeita.

---

## 3. Pronto

A URL fica tipo `https://kimo.onrender.com`. Abra no celular e adicione à tela
inicial: no Chrome, menu **⋮ → Adicionar à tela inicial**. Ele abre sem a barra
de endereço, parecendo um app.

---

## O plano grátis dorme

Depois de 15 minutos sem acesso o serviço hiberna, e a primeira visita seguinte
demora ~50 segundos para responder. Isso é do plano Free do Render, não do Kimo.

Se incomodar, as saídas são: o plano pago do Render (US$ 7/mês, sem hibernação),
ou continuar rodando no Termux, que não dorme.

Não vale a pena usar um cron externo para "acordar" o serviço de tempos em
tempos — o Render conta essas requisições nas horas gratuitas do mês e o serviço
acaba suspenso antes do fim do período.

---

## Chave: servidor ou navegador

Com `XKIRO_API_KEY` configurada no Render, qualquer pessoa que abrir a URL
conversa usando a *sua* chave e gasta do *seu* saldo. A URL do Render é pública
e indexável.

Se for só para você, tudo bem. Se pretende compartilhar, deixe a variável vazia:
o app então pede a chave na tela de Ajustes e ela fica no navegador de cada um,
sem passar pelo seu saldo. O campo em Ajustes tem prioridade sobre a variável do
servidor, então dá para começar com uma e mudar depois.

---

## Se algo falhar

**Deploy sobe mas a página não abre** — confira o Start Command: precisa ser
`node server.js`, sem Build Command.

**A página abre e o chat responde 401** — a chave está inválida ou não foi
salva. Gere outra em <https://xkiro.com/dashboard/api/keys>. Abra
`https://SEU-APP.onrender.com/api/verify` para ver o diagnóstico.

**Chat responde 403** — a chave é válida, mas a conta não tem acesso àquele
modelo. Os modelos `z-ai/*` são pagos. Marque *Só modelos gratuitos* nos Ajustes
ou adicione saldo.

**A resposta chega toda de uma vez, sem efeito de digitação** — não deveria
acontecer: o servidor manda `X-Accel-Buffering: no`. Se ocorrer, veja os logs no
painel do Render.
