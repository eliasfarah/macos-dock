# macOS Dock Stack

Extensão para o GNOME Shell que reproduz a animação de **Stack da Dock do
macOS** (Finder Stack): um ícone da dock configurado como pasta se expande,
a partir do próprio ícone, em um painel de vidro com efeito de mola
(spring), blur de fundo real e revelação escalonada dos itens.

## Estrutura

```
metadata.json                extension.js               prefs.js
stylesheet.css
schemas/org.gnome.shell.extensions.macos-dock-stack.gschema.xml
modules/
  utils.js        helpers de geometria, matemática e listagem de pastas
  settings.js      wrapper sobre o GSettings
  animations.js    curva de mola manual (spring) e o driver de animação
  glass.js         painel de vidro em camadas (blur + tint + sheen + borda)
  stack.js         Stack (ciclo de vida do painel) e StackManager
  dock.js          injeção de ícones na Dash nativa / Dash to Dock / Dash to Panel
```

## Instalação

1. Copie (ou faça symlink) desta pasta para o diretório de extensões do
   usuário, usando o UUID como nome do diretório:

   ```sh
   ln -s "$(pwd)" ~/.local/share/gnome-shell/extensions/macos-dock-stack@eliasfa.gmail.com
   ```

2. Compile o schema do GSettings:

   ```sh
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/macos-dock-stack@eliasfa.gmail.com/schemas/
   ```

3. Recarregue o GNOME Shell:
   - **X11**: `Alt+F2`, digite `r`, Enter.
   - **Wayland**: encerre a sessão e entre novamente (não há como
     recarregar o Shell em Wayland sem reiniciar a sessão).

4. Ative a extensão:

   ```sh
   gnome-extensions enable macos-dock-stack@eliasfa.gmail.com
   ```

5. Abra as preferências para adicionar pastas como stacks:

   ```sh
   gnome-extensions prefs macos-dock-stack@eliasfa.gmail.com
   ```

   Use o botão **+** na página "Stacks" para escolher uma pasta. Ela passa
   a aparecer como um ícone na dock; clicar nele expande o stack.

## Onde o ícone aparece

- **Dash nativa do GNOME**: visível apenas dentro da Overview
  (Atividades), já que o GNOME padrão não tem uma dock persistente na
  área de trabalho.
- **Dash to Dock** / **Dash to Panel**: se qualquer uma dessas extensões
  estiver instalada e ativa, o ícone também é injetado nela, dando o
  efeito de uma dock sempre visível, como no macOS.

## Desinstalação

```sh
gnome-extensions disable macos-dock-stack@eliasfa.gmail.com
rm ~/.local/share/gnome-shell/extensions/macos-dock-stack@eliasfa.gmail.com
```
