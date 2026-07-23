/* prefs.js
 *
 * Preferences UI (Adwaita / GTK4, runs in a separate process from the
 * shell). Two pages: general animation/appearance/layout knobs bound
 * directly to GSettings, and a "Stacks" page to add/remove/rename the
 * folders that should behave as macOS-style Dock stacks.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { StackSettings } from './modules/settings.js';
import { generateStackId } from './modules/utils.js';

const DIRECTION_VALUES = ['auto', 'up', 'down'];
const MODE_VALUES = ['grid', 'fan', 'stack'];

// gettext can only be called once the extension is actually running (it
// resolves the caller against the loaded-extensions registry), so these
// labels must be built lazily inside a method, not at module-evaluation time.
function directionLabels() {
    return [_('Automático'), _('Para cima'), _('Para baixo')];
}

function modeLabels() {
    return [_('Grade'), _('Leque'), _('Pilha')];
}

export default class MacosDockStackPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const gsettings = this.getSettings();
        const settings = new StackSettings(gsettings);

        window.set_default_size(640, 720);
        window.add(this._buildGeneralPage(gsettings));
        window.add(this._buildStacksPage(window, settings));
    }

    // -- general page --------------------------------------------------

    _buildGeneralPage(gsettings) {
        const page = new Adw.PreferencesPage({
            title: _('Geral'),
            icon_name: 'preferences-system-symbolic',
        });

        const animationGroup = new Adw.PreferencesGroup({ title: _('Animação') });
        page.add(animationGroup);
        animationGroup.add(this._spinRow(gsettings, 'animation-speed', {
            title: _('Velocidade da animação'),
            subtitle: _('Multiplicador aplicado à animação de mola'),
            lower: 0.5, upper: 2.5, step: 0.1, digits: 1,
        }));
        animationGroup.add(this._switchRow(gsettings, 'overshoot-enabled', {
            title: _('Overshoot da mola'),
            subtitle: _('Ultrapassa levemente o valor final antes de assentar (~3%), como no macOS'),
        }));
        animationGroup.add(this._spinRow(gsettings, 'stagger-delay', {
            title: _('Atraso entre itens'),
            subtitle: _('Milissegundos entre o início da revelação de cada item'),
            lower: 10, upper: 60, step: 1, digits: 0,
        }));

        const appearanceGroup = new Adw.PreferencesGroup({ title: _('Aparência') });
        page.add(appearanceGroup);
        appearanceGroup.add(this._spinRow(gsettings, 'blur-intensity', {
            title: _('Intensidade do blur'), lower: 0, upper: 100, step: 5, digits: 0,
        }));
        appearanceGroup.add(this._spinRow(gsettings, 'panel-opacity', {
            title: _('Opacidade do painel'), lower: 20, upper: 100, step: 5, digits: 0,
        }));
        appearanceGroup.add(this._switchRow(gsettings, 'shadow-enabled', {
            title: _('Sombra'), subtitle: _('Exibe uma sombra dinâmica sob o painel'),
        }));
        appearanceGroup.add(this._spinRow(gsettings, 'panel-size', {
            title: _('Tamanho do painel'), lower: 240, upper: 960, step: 20, digits: 0,
        }));

        const layoutGroup = new Adw.PreferencesGroup({ title: _('Layout') });
        page.add(layoutGroup);
        layoutGroup.add(this._comboRow(gsettings, 'display-mode', MODE_VALUES, modeLabels(), {
            title: _('Modo de exibição'),
        }));
        layoutGroup.add(this._spinRow(gsettings, 'grid-columns', {
            title: _('Colunas da grade'), lower: 2, upper: 8, step: 1, digits: 0,
        }));
        layoutGroup.add(this._comboRow(gsettings, 'open-direction', DIRECTION_VALUES, directionLabels(), {
            title: _('Direção de abertura'),
        }));

        return page;
    }

    _spinRow(gsettings, key, { title, subtitle, lower, upper, step, digits }) {
        const adjustment = new Gtk.Adjustment({
            lower, upper,
            step_increment: step,
            page_increment: step * 5,
            value: digits === 0 ? gsettings.get_int(key) : gsettings.get_double(key),
        });
        const row = new Adw.SpinRow({ title, subtitle: subtitle ?? null, adjustment, digits });
        gsettings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _switchRow(gsettings, key, { title, subtitle }) {
        const row = new Adw.SwitchRow({ title, subtitle: subtitle ?? null });
        gsettings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _comboRow(gsettings, key, values, labels, { title }) {
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(labels),
        });
        row.selected = Math.max(0, values.indexOf(gsettings.get_string(key)));
        row.connect('notify::selected', () => {
            gsettings.set_string(key, values[row.selected]);
        });
        gsettings.connect(`changed::${key}`, () => {
            const index = values.indexOf(gsettings.get_string(key));
            if (index >= 0 && index !== row.selected)
                row.selected = index;
        });
        return row;
    }

    // -- stacks page -----------------------------------------------------

    _buildStacksPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Stacks'),
            icon_name: 'folder-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Pastas configuradas'),
            description: _('Cada pasta abaixo aparece como um ícone na dock; clicar nele expande o stack a partir do próprio ícone.'),
        });
        page.add(group);

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Adicionar pasta'),
        });
        group.set_header_suffix(addButton);

        // Every mutation below (add, remove, rename) already refreshes
        // the list itself right after writing to GSettings. There's
        // deliberately no separate `settings.connectChanged` listener
        // here: the rename EntryRow's own 'changed' handler writes on
        // every keystroke, and a reactive rebuild on that write would
        // destroy the row being typed into — yanking focus out from
        // under the user after each character.
        const refresh = () => this._refreshStacksList(group, settings);
        addButton.connect('clicked', () => this._pickFolder(window, settings, refresh));

        refresh();
        return page;
    }

    _refreshStacksList(group, settings) {
        for (const row of [...(this._stackRows ?? [])])
            group.remove(row);
        this._stackRows = [];

        const stacks = settings.getStacks();
        if (stacks.length === 0) {
            const empty = new Adw.ActionRow({
                title: _('Nenhum stack configurado'),
                subtitle: _('Use o botão “+” acima para adicionar uma pasta'),
            });
            group.add(empty);
            this._stackRows.push(empty);
            return;
        }

        for (const stack of stacks) {
            const row = new Adw.EntryRow({ title: _('Nome'), text: stack.name });
            row.add_suffix(this._removeButton(settings, stack.id, group));

            // Debounced, not written on every keystroke: this same
            // 'stacks' GSettings key is also watched by the running
            // extension's DockIntegration, which rebuilds every dock
            // icon on the real desktop on each change — writing per
            // character would flicker the live dock while typing.
            row.connect('changed', () => {
                if (row._saveTimeoutId)
                    GLib.Source.remove(row._saveTimeoutId);
                row._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    row._saveTimeoutId = 0;
                    settings.updateStack(stack.id, { name: row.text });
                    return GLib.SOURCE_REMOVE;
                });
            });
            row.connect('destroy', () => {
                if (row._saveTimeoutId)
                    GLib.Source.remove(row._saveTimeoutId);
            });

            const path = new Adw.ActionRow({ subtitle: stack.path, selectable: false });
            path.add_css_class('dim-label');

            group.add(row);
            group.add(path);
            this._stackRows.push(row, path);
        }
    }

    _removeButton(settings, id, group) {
        const button = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Remover'),
        });
        button.connect('clicked', () => {
            settings.removeStack(id);
            this._refreshStacksList(group, settings);
        });
        return button;
    }

    _pickFolder(window, settings, onDone) {
        const dialog = new Gtk.FileDialog({ title: _('Selecionar pasta para o stack') });
        dialog.select_folder(window, null, (_dlg, result) => {
            try {
                const file = dialog.select_folder_finish(result);
                if (!file)
                    return;
                const path = file.get_path();
                if (settings.getStacks().some(s => s.path === path))
                    return; // already configured — avoid a duplicate dock icon
                settings.addStack({
                    id: generateStackId(),
                    name: file.get_basename(),
                    path,
                    icon: null,
                });
                onDone();
            } catch (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error('macos-dock-stack: failed to add folder', error);
            }
        });
    }
}
