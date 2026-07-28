# macOS Dock Stack

Uma dock ao estilo **macOS** para o GNOME Shell 50, construída do zero — não
um tema por cima da Dash do GNOME. Barra de vidro persistente com
magnificação no cursor, indicador de app aberto, arrastar para reordenar,
efeito *genie* ao minimizar, e **Stacks de pasta** do Finder nas três
apresentações reais do macOS: leque (Fan), grade (Grid) e lista (List).

Cada medida visual (padding, espaçamento, raio dos cantos, altura dos
separadores, tamanho e posição do indicador, e as duas paletas de vidro) foi
medida em capturas reais do Dock do macOS Tahoe, não estimada.

## Requisitos

- GNOME Shell **50** (`gnome-shell --version`)
- Sessão Wayland ou X11

## Instalação

### Pela release (recomendado)

```sh
UUID=macos-dock-stack@eliasfarah.github.io
curl -LO https://github.com/eliasfarah/macos-dock/releases/latest/download/$UUID.shell-extension.zip
gnome-extensions install --force $UUID.shell-extension.zip
```

### Pelo código-fonte

```sh
UUID=macos-dock-stack@eliasfarah.github.io
git clone https://github.com/eliasfarah/macos-dock.git
ln -s "$PWD/macos-dock" ~/.local/share/gnome-shell/extensions/$UUID
glib-compile-schemas ~/.local/share/gnome-shell/extensions/$UUID/schemas/
mkdir -p ~/.local/share/gnome-shell/extensions/$UUID/locale/pt_BR/LC_MESSAGES
msgfmt ~/.local/share/gnome-shell/extensions/$UUID/po/pt_BR.po \
  -o ~/.local/share/gnome-shell/extensions/$UUID/locale/pt_BR/LC_MESSAGES/macos-dock-stack.mo
```

O `glib-compile-schemas` não é opcional: sem ele a extensão ativa mas não
encontra nenhuma preferência. O `msgfmt` é opcional — sem ele a interface
aparece em inglês (o idioma original das strings); com ele, em português.

### Ativar

Reinicie o Shell **antes** de ativar:

- **Wayland**: encerre a sessão e entre novamente. Não existe recarga do
  Shell em Wayland — `Alt+F2 r` não existe lá, e `disable`/`enable` não
  garante que o GJS releia módulos ES alterados.
- **X11**: `Alt+F2`, `r`, Enter.

```sh
gnome-extensions enable macos-dock-stack@eliasfarah.github.io
gnome-extensions prefs  macos-dock-stack@eliasfarah.github.io
```

Na página **Stacks**, o botão **+** adiciona uma pasta; ela vira um ícone na
dock que mostra uma prévia do conteúdo e expande ao clicar.

Se o **Dash to Dock** estiver ativo, a extensão o desativa ao iniciar — as
duas são docks persistentes e brigariam pelo mesmo espaço. Isso não é
revertido ao desativar esta; reative-o você mesmo se quiser voltar.

## O que ela faz

**Dock**

- Barra de vidro com blur real do fundo (`Shell.BlurEffect`), claro/escuro/
  automático seguindo `org.gnome.desktop.interface color-scheme`.
- Magnificação gaussiana ao redor do cursor, como o Dock real.
- Apps fixados e apps abertos, separados pelos mesmos dois divisores que o
  macOS desenha; indicador de app aberto abaixo do ícone.
- Arrastar para reordenar apps e stacks; soltar fora da dock desafixa.
- Ocultar automaticamente, tamanho de ícone, margem e intensidade do blur —
  todos com efeito imediato, sem novo login.
- Lixeira cheia/vazia, acompanhando o conteúdo real.

**Stacks de pasta**

- **Fan**: os itens sobem do próprio ícone flutuando sobre a área de
  trabalho, sem painel, com o nome de cada um numa placa à esquerda.
- **Grid** e **List**: painel de vidro dimensionado pelo conteúdo.
- Ordenação por data, mais recente primeiro — como o "Date Added" do
  Finder — então a prévia no ícone é sempre o último arquivo que chegou.
- Barra de progresso no ícone enquanto um download está em andamento.

## Preferências

`gnome-extensions prefs macos-dock-stack@eliasfarah.github.io`, ou pelo app
**Extensões**.

## Desinstalação

```sh
UUID=macos-dock-stack@eliasfarah.github.io
gnome-extensions disable $UUID
rm -r ~/.local/share/gnome-shell/extensions/$UUID
```

## Estrutura

```
extension.js                 ponto de entrada; conecta os colaboradores
prefs.js                     janela de preferências (GTK4/Adwaita)
stylesheet.css               as duas paletas de vidro (clara e escura)
schemas/                     gschema do GSettings
modules/
  appearance.js              claro / escuro / seguir o sistema
  animations.js              curva de mola (spring) e o driver de animação
  glass.js                   vidro em camadas: blur, tint, sheen, rim, borda
  utils.js                   geometria, listagem e ordenação de pastas
  settings.js                wrapper sobre o GSettings
  stack.js                   Stack (ciclo de vida do painel) e StackManager
  dockManager.js             a barra: layout, magnificação, DnD, autohide
  dockAppIcon.js             ícone de app (estende AppDisplay.AppIcon)
  dockFolderIcon.js          ícone de pasta: prévia empilhada e progresso
  dockTrashIcon.js           lixeira cheia/vazia
  dockShowAppsIcon.js        lançador de apps
  dockSeparator.js           os divisores da barra
  minimizeEffect.js          efeito genie ao minimizar
```

## Desenvolvimento

Testar código novo do Shell na sessão real é arriscado — em Wayland uma
falha do `gnome-shell` derruba a sessão inteira. Use uma sessão headless
isolada:

```sh
export XDG_CONFIG_HOME=/tmp/dock-test/.config   # isola o dconf
export XDG_DATA_HOME=$HOME/.local/share         # mantém o symlink visível
dbus-run-session -- bash -c '
  gsettings set org.gnome.shell enabled-extensions "[\"macos-dock-stack@eliasfarah.github.io\"]"
  gnome-shell --headless --virtual-monitor 1600x900 --debug-control
'
```

`--debug-control` importa: sem ele os avisos de Clutter/Mutter são filtrados
e bugs reais ficam invisíveis. Toda escrita de `gsettings` precisa rodar
**dentro** do mesmo `dbus-run-session` — o dconf vai pelo barramento, e
`XDG_CONFIG_HOME` sozinho não isola nada.
