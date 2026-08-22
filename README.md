# Stock Lab (PWA)

Versão portátil, instalável no celular, do Stock Strategy Simulator.
Single-file HTML/JS/CSS, 100% client-side — sem servidor, sem Python,
sem Streamlit. Dados salvos em `localStorage` no próprio dispositivo.

Mesmo motor de cálculo da versão Python (`stock-lab`/`stock-sim`):
custo médio móvel japonês, caixa, fiscal, break-even fiscal e econômico,
simulador de ciclos, relatório fiscal com compensação de prejuízo,
multi-ticker, import CSV, export CSV/Excel/PDF.

**Suporte a moeda por ticker (JPY/USD):** cada ticker é cadastrado como
ação japonesa (¥) ou americana ($). Para tickers em USD, cada compra/venda
registra a cotação USD/JPY usada naquele momento (editável por operação,
com um valor padrão configurável em ⚙️ Configurações). O resultado fiscal
e o imposto estimado são **sempre calculados em ¥**, como exige a lei
japonesa — independente da moeda do ativo. O dashboard mostra o custo
médio tanto na moeda nativa quanto seu equivalente em ¥.

## Instalar no celular

1. Publicar via GitHub Pages (`kamebug.github.io/stock-lab/` ou nome
   equivalente) — precisa estar em `https://` para o PWA funcionar.
2. Abrir a URL no navegador do celular.
3. Menu do navegador → "Adicionar à tela inicial" / "Instalar app".

## Rodar localmente (dev)

```bash
python3 -m http.server 8000
# abrir http://localhost:8000
```

## Estrutura

```
stock-lab-pwa/
├── index.html       # UI (dashboard, abas, formulários)
├── app.js           # engine + storage + UI (single file, ~1500 linhas)
├── manifest.json     # PWA manifest
├── sw.js             # service worker (cache offline)
├── icons/            # ícones 192/512
└── .nojekyll
```

## Bibliotecas externas (via CDN)

- Chart.js 4.4.1 — gráficos
- SheetJS (xlsx) 0.18.5 — export Excel
- jsPDF 2.5.1 + jspdf-autotable 3.8.2 — export PDF

Todas carregadas via `cdnjs.cloudflare.com`. Sem essas libs (offline na
primeira visita), o service worker ainda cacheia o app principal, mas
gráficos/exports precisam de rede na primeira carga.

## Versionamento

`CACHE_VERSION` em `sw.js` deve sempre subir junto com qualquer mudança
em `index.html`/`app.js`, senão o navegador serve a versão antiga em
cache. Formato do BUILD_ID: `aammddhhmm` em JST.

## Limitações conhecidas

Mesmas da versão Python: motor fiscal é custo médio móvel simplificado,
não validado contra metodologia oficial da NTA; só JPY por enquanto;
sem API de preço em tempo real.
