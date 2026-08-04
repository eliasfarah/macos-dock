# Memória do projeto

Atualizado em 4 de agosto de 2026.

## Projeto

- Repositório: `git@github.com:eliasfarah/macos-dock.git`
- Branch principal: `main`
- Extensão: `macos-dock-stack@eliasfarah.github.io`
- Versão atual: `1.4.4`
- Ambiente principal: GNOME Shell 50.3 em Wayland
- O diretório instalado da extensão é um link para este repositório.
- Em Wayland, mudanças nos módulos JavaScript só são carregadas com logout/login completo.

## Preferências de trabalho

- Preservar fidelidade visual ao Dock do macOS.
- Investigar sinais, layout, animações e condições de corrida antes de considerar um bug resolvido.
- Nunca testar alterações diretamente na sessão Wayland em uso; utilizar uma sessão GNOME Shell headless isolada.
- Manter o `XDG_CONFIG_HOME` da sessão de teste isolado para não alterar as preferências reais.
- Código-fonte e strings originais em inglês; português brasileiro fica no catálogo `po/pt_BR.po`.

## Bug: dock desce e perde a margem inferior

Relato original: em algum momento a dock se movimenta para baixo, deixa de flutuar e fica colada na borda inferior do monitor, sem espaço para “respirar”.

O primeiro reparo foi introduzido no commit `52847fe` como `self-heal dock geometry drift`, mas o bug permaneceu. O observador antigo dependia somente de notificações de allocation/translation. Ele podia perder uma alteração ocorrida durante outro layout, não observava o resultado realmente pintado na tela e ainda aceitava um fallback de área de trabalho quando o monitor primário estava temporariamente indisponível.

### Correção atual

- Um layout solicitado durante outro layout não é mais descartado; ele é repetido de forma coalescida.
- A dock não é reposicionada usando dados de fallback quando o monitor primário está indisponível durante login, troca de modo ou hotplug.
- Com autohide desligado, qualquer `translation_y` residual é zerado em todo layout válido.
- A posição pintada é comparada com a borda real do monitor e com `dock-edge-margin`.
- Um watchdog de um segundo cobre notificações perdidas. Ele usa `GLib.timeout_add_seconds()` com prioridade de idle, permitindo que o GLib agrupe o wake-up. Quando a geometria está correta, faz apenas leituras e aritmética; não redesenha nem executa relayout.
- O estado escondido do autohide é tratado separadamente para não combater a animação intencional.

Arquivos da correção:

- `modules/dockManager.js`
- `modules/dockGeometry.js`
- `tests/dockGeometry.test.js`

### Validação realizada

- Testes de geometria: 4/4 passaram.
- Testes de aplicativos recentes: 46/46 passaram.
- Sintaxe JavaScript e `git diff --check`: passaram.
- Sessão GNOME Shell 50 headless isolada, margem configurada em 6 px:
  - estado normal: `gap=6`, `translation_y=0`;
  - deslocamento artificial: `gap=0`, `translation_y=6`;
  - depois do reparo: `gap=6`, `translation_y=0`.
- O mesmo teste passou com as notificações do ator congeladas, comprovando que o watchdog cobre o caso perdido pelo observador antigo.
- Autohide validado: estado escondido manteve a translação esperada, um deslocamento artificial foi reparado e a dock voltou a `gap=6` ao desativar o autohide.
- Nenhum erro JavaScript ou Clutter da extensão apareceu nas sessões isoladas.

## Próxima confirmação

Após carregar este código com logout/login, usar a dock normalmente na sessão real e confirmar que ela não volta a encostar na borda. Se ocorrer novamente, procurar no journal pela mensagem:

`macos-dock-stack: dock geometry drifted, repositioned`
