/*
 * Copyright 2021 Simon Edwards <simon@simonzone.com>
 *
 * This source code is licensed under the MIT license which is detailed in the LICENSE.txt file.
 */
import * as Electron from 'electron';
import * as _ from 'lodash';
import * as SourceMapSupport from 'source-map-support';

import { DeepReadonly, freezeDeep } from 'extraterm-readonly-toolbox';
import { Event, CustomizedCommand, SessionConfiguration} from '@extraterm/extraterm-extension-api';
import { loadFile as loadFontFile} from "extraterm-font-ligatures";
import { doLater, later } from 'extraterm-later';
import { LigatureMarker } from 'extraterm-ace-terminal-renderer';
import { createUuid } from 'extraterm-uuid';

import './gui/All'; // Need to load all of the GUI web components into the browser engine
import {CheckboxMenuItem} from './gui/CheckboxMenuItem';
import { CommandPalette } from "./command/CommandPalette";
import { EVENT_CONTEXT_MENU_REQUEST, ContextMenuType, EVENT_HYPERLINK_CLICK, HyperlinkEventDetail } from './command/CommandUtils';
import { ConfigChangeEvent, ConfigDatabase } from "../ConfigDatabase";
import { SESSION_CONFIG, SystemConfig, GENERAL_CONFIG, SYSTEM_CONFIG, GeneralConfig, FontInfo, MouseButtonAction } from '../Config';
import {DropDown} from './gui/DropDown';
import {EmbeddedViewer} from './viewers/EmbeddedViewer';
import {ExtensionManagerImpl} from './extension/ExtensionManager';
import {ExtensionManager, CommandQueryOptions} from './extension/InternalTypes';
import {EVENT_DRAG_STARTED, EVENT_DRAG_ENDED} from './GeneralEvents';
import {Logger, getLogger} from "extraterm-logging";
import {MainWebUi} from './MainWebUi';
import {MenuItem} from './gui/MenuItem';
import {PopDownListPicker} from './gui/PopDownListPicker';
import {ResizeCanary} from './ResizeCanary';
import {SettingsTab} from './settings/SettingsTab';
import {TabWidget} from './gui/TabWidget';
import {EtTerminal} from './Terminal';
import {TerminalViewer} from './viewers/TerminalAceViewer';
import {TextViewer} from'./viewers/TextAceViewer';
import * as ThemeTypes from '../theme/Theme';
import * as ThemeConsumer from '../theme/ThemeConsumer';
import * as WebIpc from './WebIpc';
import * as Messages from '../WindowMessages';
import { EventEmitter } from '../utils/EventEmitter';
import { log } from "extraterm-logging";
import { KeybindingsManager, loadKeybindingsFromObject, TermKeybindingsMapping } from './keybindings/KeyBindingsManager';
import { trimBetweenTags } from 'extraterm-trim-between-tags';
import { ApplicationContextMenu } from "./command/ApplicationContextMenu";
import { registerCommands as TextCommandsRegisterCommands } from "./viewers/TextCommands";
import { DisposableHolder } from '../utils/DisposableUtils';
import { ExtensionCommandContribution, Category } from '../ExtensionMetadata';
import { EtViewerTab } from './ViewerTab';
import { isSupportsDialogStack } from './SupportsDialogStack';
import { TerminalVisualConfig } from './TerminalVisualConfig';
import { FontLoader, DpiWatcher } from './gui/Util';
import { CachingLigatureMarker } from './CachingLigatureMarker';
import { focusElement } from './DomUtils';
import * as SharedMap from "../shared_map/SharedMap";

type ThemeInfo = ThemeTypes.ThemeInfo;

SourceMapSupport.install();

const ID_MENU_BUTTON = "ID_MENU_BUTTON";
const CLASS_DISABLE_WINDOW_MOVE = "CLASS_DISABLE_WINDOW_MOVE";
const CLASS_ENABLE_WINDOW_MOVE = "CLASS_ENABLE_WINDOW_MOVE";

const _log = getLogger("mainweb");

/**
 * This module has control of the window and is responsible for
 * starting up the main component and handling the window directly.
 */

let terminalVisualConfig: TerminalVisualConfig = null;
const windowId = createUuid();


let closeSplashFunc: () => void = null;

export async function asyncStartUp(closeSplash: () => void, windowUrl: string): Promise<void> {
  closeSplashFunc = closeSplash;

  const parsedWindowUrl = new URL(windowUrl);
  const bareWindow = parsedWindowUrl.searchParams.get("bareWindow") !== null;

  const fontLoader = new FontLoader();
  const dpiWatcher = new DpiWatcher();
  startUpTheming();
  startUpWebIpc();

  const sharedMap = await setupSharedMap();
  const configDatabase = new ConfigDatabase(sharedMap);
  configDatabase.start();
  const keybindingsManager = new KeybindingsManagerImpl();

  configDatabase.onChange( (ev: ConfigChangeEvent) => {
    if ([GENERAL_CONFIG, SYSTEM_CONFIG].indexOf(ev.key) === -1) {
      return;
    }
    applyConfiguration(configDatabase, keybindingsManager, fontLoader, mainWebUi);
  });
  await applyConfiguration(configDatabase, keybindingsManager, fontLoader, null);

  const themeListMsg = await WebIpc.requestThemeList();
  const themesMessage = <Messages.ThemeListMessage> themeListMsg;
  const themes = themesMessage.themeInfo;

  await asyncLoadTerminalTheme(configDatabase, fontLoader);

  const doc = window.document;
  doc.body.classList.add(CLASS_ENABLE_WINDOW_MOVE);

  const extensionManager = startUpExtensions(configDatabase, sharedMap);

  const mainWebUi = startUpMainWebUi(configDatabase, extensionManager, keybindingsManager, themes);
  extensionManager.setSplitLayout(mainWebUi.getSplitLayout());
  extensionManager.setViewerTabDisplay(mainWebUi);

  const applicationContextMenu = startUpApplicationContextMenu(extensionManager, keybindingsManager, mainWebUi);
  registerIpcHandlers(extensionManager, mainWebUi, applicationContextMenu, sharedMap);

  const commandPalette = startUpCommandPalette(extensionManager, keybindingsManager);
  registerCommands(extensionManager, commandPalette);
  startUpSessions(configDatabase, extensionManager);

  startUpMainMenu(extensionManager, keybindingsManager);
  startUpWindowEvents(configDatabase, mainWebUi);

  dpiWatcher.onChange(newDpi => handleDpiChange(mainWebUi, newDpi));

  if (configDatabase.getSessionConfig().length !== 0) {
    if (bareWindow) {
      mainWebUi.render();
    } else {
      await mainWebUi.commandNewTerminal({ sessionUuid: configDatabase.getSessionConfig()[0].uuid });
    }
  } else {
    mainWebUi.commandOpenSettingsTab("session");
    Electron.remote.dialog.showErrorBox("No session types available",
      "Extraterm doesn't have any session types configured.");
  }
  focusElement(mainWebUi, _log);
  window.focus();

  WebIpc.windowReady();
}

async function setupSharedMap(): Promise<SharedMap.SharedMap> {
  const sharedMap = new SharedMap.SharedMap();

  WebIpc.registerDefaultHandler(Messages.MessageType.SHARED_MAP_EVENT,
    (msg: Messages.Message) => {
      const sharedMapEventMessage = <Messages.SharedMapEventMessage> msg;
      sharedMap.sync(sharedMapEventMessage.event);
    });

  const sharedMapDumpMsg = await WebIpc.requestSharedMapDump();
  sharedMap.loadAll(sharedMapDumpMsg.data);

  sharedMap.onChange((ev: SharedMap.ChangeEvent) => {
    if ( ! ev.isLocalOrigin) {
      return;
    }
    WebIpc.sendSharedMapEvent(ev);
  });

  return sharedMap;
}

function startUpTheming(): void {
  // Theme control for the window level.
  const topThemeable: ThemeTypes.Themeable = {
    setThemeCssMap(cssMap: Map<ThemeTypes.CssFile, string>): void {
      const styleText =
        cssMap.get(ThemeTypes.CssFile.GENERAL_GUI) + "\n" +
        cssMap.get(ThemeTypes.CssFile.FONT_AWESOME) + "\n" +
        cssMap.get(ThemeTypes.CssFile.TOP_WINDOW) + "\n" +
        cssMap.get(ThemeTypes.CssFile.TERMINAL_VARS) + "\n" +
        cssMap.get(ThemeTypes.CssFile.THEME_VARS);
      (<HTMLStyleElement> document.getElementById('THEME_STYLE')).textContent = styleText;
    }
  };
  ThemeConsumer.registerThemeable(topThemeable);
}

function startUpWebIpc(): void {
  WebIpc.start();

  WebIpc.registerDefaultHandler(Messages.MessageType.CLOSE_SPLASH, closeSplash);

  // Default handling for theme messages.
  WebIpc.registerDefaultHandler(Messages.MessageType.THEME_CONTENTS, handleThemeContentsMessage);
}

function registerIpcHandlers(extensionManager: ExtensionManager, mainWebUi: MainWebUi,
    applicationContextMenu: ApplicationContextMenu, sharedMap: SharedMap.SharedMap): void {

  WebIpc.registerDefaultHandler(Messages.MessageType.DEV_TOOLS_STATUS,
    (msg: Messages.Message) => handleDevToolsStatus(applicationContextMenu, msg));

  WebIpc.registerDefaultHandler(Messages.MessageType.EXECUTE_COMMAND_REQUEST,
    (msg: Messages.ExecuteCommandMessage) => handleExecuteCommand(extensionManager, msg));

  WebIpc.registerDefaultHandler(Messages.MessageType.QUIT_APPLICATION,
    (msg: Messages.Message) => handleCloseWindow(mainWebUi, msg));

  WebIpc.registerDefaultHandler(Messages.MessageType.THEME_LIST,
    (msg: Messages.Message) => handleThemeListMessage(mainWebUi, msg));

  WebIpc.registerDefaultHandler(Messages.MessageType.CLIPBOARD_READ,
    (msg: Messages.Message) => handleClipboardRead(mainWebUi, msg));

}

function closeSplash(): void {
  if (closeSplashFunc == null) {
    return;
  }
  closeSplashFunc();
  closeSplashFunc = null;
}

async function handleExecuteCommand(extensionManager: ExtensionManager, msg: Messages.ExecuteCommandMessage): Promise<void> {
  await later();

  const executeCommandMessage = <Messages.ExecuteCommandMessage> msg;
  let exception: any = null;
  let result: any = null;
  try {
    result = extensionManager.executeCommand(executeCommandMessage.commandName, executeCommandMessage.args);
    if (result instanceof Promise) {
      result = await result;
    }
  } catch(ex) {
    exception = <Error> ex;
  }

  WebIpc.commandResponse(msg.uuid, result, exception);
}

async function asyncLoadTerminalTheme(configDatabase: ConfigDatabase, fontLoader: FontLoader): Promise<void> {
  const config = configDatabase.getGeneralConfig();
  const systemConfig = configDatabase.getSystemConfig();
  const themeMsg = await WebIpc.requestTerminalTheme(config.themeTerminal);

  const fontFilePath = getFontFilePath(systemConfig.availableFonts, config.terminalFont);

  let ligatureMarker: LigatureMarker = null;
  if (config.terminalDisplayLigatures) {
    const plainlLigatureMarker = await loadFontFile(fontFilePath);
    if (plainlLigatureMarker != null) {
      ligatureMarker = new CachingLigatureMarker(plainlLigatureMarker);
    }
  }

  terminalVisualConfig = {
    cursorStyle: config.cursorStyle,
    cursorBlink: config.blinkingCursor,
    fontFamily: fontLoader.cssNameFromFontName(config.terminalFont),
    fontSizePx: config.terminalFontSize,
    fontFilePath,
    devicePixelRatio: window.devicePixelRatio,
    terminalTheme: themeMsg.terminalTheme,
    transparentBackground: config.windowBackgroundMode !== "opaque",
    useLigatures: config.terminalDisplayLigatures,
    ligatureMarker
  };
}

function startUpMainWebUi(configDatabase: ConfigDatabase, extensionManager: ExtensionManager,
    keybindingsManager: KeybindingsManager, themes: ThemeInfo[]): MainWebUi {

  const mainWebUi = <MainWebUi>window.document.createElement(MainWebUi.TAG_NAME);
  mainWebUi.windowId = windowId;
  mainWebUi.setDependencies(configDatabase, keybindingsManager, extensionManager);
  mainWebUi.setTerminalVisualConfig(terminalVisualConfig);

  const systemConfig = configDatabase.getSystemConfig();
  const showWindowControls = systemConfig.titleBarStyle === "compact" && process.platform !== "darwin";
  let windowControls = "";
  if (showWindowControls) {
    windowControls = windowControlsHtml();
  }

  mainWebUi.innerHTML = trimBetweenTags(`<div class="tab_bar_rest">
    <div class="space"></div>
    <button id="${ID_MENU_BUTTON}" class="quiet"><i class="fa fa-bars"></i></button>
    ${windowControls}
    </div>`);

  mainWebUi.setThemes(themes);
  window.document.body.appendChild(mainWebUi);

  // Detect when the last tab has closed.
  mainWebUi.addEventListener(MainWebUi.EVENT_TAB_CLOSED, (ev: CustomEvent) => {
    const generalConfig = <GeneralConfig> configDatabase.getGeneralConfig();
    if (generalConfig.closeWindowWhenEmpty && mainWebUi.getTabCount() === 0) {
      WebIpc.windowCloseRequest();
    }
  });

  // Update the window title on request.
  mainWebUi.addEventListener(MainWebUi.EVENT_TITLE, (ev: CustomEvent) => {
    window.document.title = "Extraterm - " + ev.detail.title;
  });

  if (showWindowControls) {
    setUpWindowControls(mainWebUi);
  }

  mainWebUi.addEventListener(MainWebUi.EVENT_MINIMIZE_WINDOW_REQUEST, () => {
    WebIpc.windowMinimizeRequest();
  });

  mainWebUi.addEventListener(MainWebUi.EVENT_MAXIMIZE_WINDOW_REQUEST, () => {
    WebIpc.windowMaximizeRequest();
  });

  mainWebUi.addEventListener(MainWebUi.EVENT_CLOSE_WINDOW_REQUEST, () => {
    WebIpc.windowCloseRequest();
  });

  mainWebUi.addEventListener(MainWebUi.EVENT_QUIT_APPLICATION_REQUEST, () => {
    WebIpc.requestQuitApplication();
  });

  mainWebUi.addEventListener(EVENT_DRAG_STARTED, () => disableWindowMoveArea(mainWebUi));
  mainWebUi.addEventListener(EVENT_DRAG_ENDED, () => enableWindowMoveArea(mainWebUi));

  mainWebUi.addEventListener(EVENT_HYPERLINK_CLICK,
    (ev: CustomEvent) => handleHyperlinkClick(extensionManager, ev));

  window.addEventListener("keydown",
    (ev: KeyboardEvent) => handleKeyDownCapture(extensionManager, keybindingsManager, ev), true);

  window.addEventListener("keypress",
  (ev: KeyboardEvent) => handleKeyPressCapture(extensionManager, keybindingsManager, ev), true);

  return mainWebUi;
}

function handleKeyDownCapture(extensionManager: ExtensionManager, keybindingsManager: KeybindingsManager,
    ev: KeyboardEvent): void {
  handleKeyCapture(extensionManager, keybindingsManager, ev);
}

function handleKeyPressCapture(extensionManager: ExtensionManager, keybindingsManager: KeybindingsManager,
    ev: KeyboardEvent): void {
  handleKeyCapture(extensionManager, keybindingsManager, ev);
}

function handleKeyCapture(extensionManager: ExtensionManager, keybindingsManager: KeybindingsManager,
    ev: KeyboardEvent): void {

  const commands = keybindingsManager.getKeybindingsMapping().mapEventToCommands(ev);
  extensionManager.updateExtensionWindowStateFromEvent(ev);

  const categories: Category[] = extensionManager.isInputFieldFocus()
                                  ? ["application", "window"]
                                  : null;
  const filteredCommands = extensionManager.queryCommands({
    commands,
    categories: categories,
    when: true
  });
  if (filteredCommands.length !== 0) {
    if (filteredCommands.length !== 1) {
      _log.warn(`Commands ${filteredCommands.map(fc => fc.command).join(", ")} have conflicting keybindings.`);
    }

    extensionManager.executeCommand(filteredCommands[0].command);
    ev.stopPropagation();
    ev.preventDefault();
  }
}

function handleHyperlinkClick(extensionManager: ExtensionManager, ev: CustomEvent): void {
  const details = <HyperlinkEventDetail> ev.detail;
  extensionManager.updateExtensionWindowStateFromEvent(ev);

  const options: CommandQueryOptions = {
    when: true,
    categories: ["hyperlink"]
  };
  const contextWindowState = extensionManager.getExtensionWindowStateFromEvent(ev);
  contextWindowState.activeHyperlinkURL = details.url;
  const entries = extensionManager.queryCommandsWithExtensionWindowState(options, contextWindowState);
  if (entries.length === 0) {
    return;
  }

  const commandName = entries[0].command;
  extensionManager.executeCommandWithExtensionWindowState(contextWindowState, commandName);
}

function disableWindowMoveArea(mainWebUi: MainWebUi): void {
  window.document.body.classList.add(CLASS_DISABLE_WINDOW_MOVE);
  window.document.body.classList.remove(CLASS_ENABLE_WINDOW_MOVE);

  mainWebUi.classList.add(CLASS_DISABLE_WINDOW_MOVE);
  mainWebUi.classList.remove(CLASS_ENABLE_WINDOW_MOVE);
}

function enableWindowMoveArea(mainWebUi: MainWebUi): void {
  window.document.body.classList.remove(CLASS_DISABLE_WINDOW_MOVE);
  window.document.body.classList.add(CLASS_ENABLE_WINDOW_MOVE);

  mainWebUi.classList.remove(CLASS_DISABLE_WINDOW_MOVE);
  mainWebUi.classList.add(CLASS_ENABLE_WINDOW_MOVE);
}

const ID_CONTROLS_SPACE = "ID_CONTROLS_SPACE";
const ID_MINIMIZE_BUTTON = "ID_MINIMIZE_BUTTON";
const ID_MAXIMIZE_BUTTON = "ID_MAXIMIZE_BUTTON";
const ID_CLOSE_BUTTON = "ID_CLOSE_BUTTON";

function windowControlsHtml(): string {
  return trimBetweenTags(
    `<div id="${ID_CONTROLS_SPACE}"></div>
    <button id="${ID_MINIMIZE_BUTTON}" tabindex="-1"></button>
    <button id="${ID_MAXIMIZE_BUTTON}" tabindex="-1"></button>
    <button id="${ID_CLOSE_BUTTON}" tabindex="-1"></button>`);
}

function setUpWindowControls(mainWebUi: MainWebUi): void {
  document.getElementById(ID_MINIMIZE_BUTTON).addEventListener('click', () => {
    WebIpc.windowMinimizeRequest();
  });

  const maximizeButton = document.getElementById(ID_MAXIMIZE_BUTTON);
  maximizeButton.addEventListener('click', () => {
    WebIpc.windowMaximizeRequest();
    doLater(() => {
      focusElement(mainWebUi, _log);
    });
  });

  document.getElementById(ID_CLOSE_BUTTON).addEventListener('click', () => {
    WebIpc.windowCloseRequest();
  });
}

function startUpMainMenu(extensionManager: ExtensionManager, keybindingsManager: KeybindingsManager): void {
  const windowMenu = new ApplicationContextMenu(extensionManager, keybindingsManager);
  const menuButton = document.getElementById(ID_MENU_BUTTON);
  menuButton.addEventListener('click', () => {
    windowMenu.openAround(menuButton, ContextMenuType.WINDOW_MENU);
  });
}

function mapEventToMouseButtonActionKey(ev: MouseEvent): string {
  const isMiddleButton = ev.buttons === 4;
  const isRightButton = (ev.buttons & 2) !== 0;
  if ( ! isMiddleButton && ! isRightButton) {
    return null;
  }

  const buttonString = isMiddleButton ? "middle" : "right";
  const modifierString = ev.ctrlKey ? "Control" : (ev.shiftKey ? "Shift" : "");
  return `${buttonString}MouseButton${modifierString}Action`;
}

function startUpWindowEvents(configDatabase: ConfigDatabase, mainWebUi: MainWebUi): void {
  // Make sure something sensible is focussed if only the window gets the focus.
  window.addEventListener('focus', (ev: FocusEvent) => {
    if (ev.target === window) {
      focusElement(mainWebUi, _log);
    }
  });

  window.document.addEventListener('mousedown', (ev: MouseEvent) => {
    if (ev.which === 2) {
      const key = mapEventToMouseButtonActionKey(ev);
      const generalConfig = configDatabase.getGeneralConfig();
      const action = <MouseButtonAction> generalConfig[key];
      if (action === 'paste') {
        WebIpc.clipboardReadRequest();
      }

      // This is needed to stop the autoscroll blob from appearing on Windows.
      ev.preventDefault();
      ev.stopPropagation();
    }
  });

  window.document.addEventListener('dragover', (ev: DragEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  window.document.addEventListener('drop', (ev: DragEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
}

function startUpExtensions(configDatabase: ConfigDatabase, sharedMap: SharedMap.SharedMap): ExtensionManager {
  const extensionManager = new ExtensionManagerImpl(configDatabase, sharedMap);
  extensionManager.startUp();
  return extensionManager;
}

function registerCommands(extensionManager: ExtensionManager, commandPalette: CommandPalette): void {
  const commands = extensionManager.getExtensionContextByName("internal-commands").commands;
  commands.registerCommand("extraterm:window.toggleDeveloperTools", commandToggleDeveloperTools,
                            customizeToggleDeveloperTools);
  commands.registerCommand("extraterm:window.reloadCss", commandReloadThemeContents);
  commands.registerCommand("extraterm:application.openCommandPalette",
    () => commandOpenCommandPalette(extensionManager, commandPalette));
  commands.registerCommand("extraterm:application.newWindow", commandNewWindow);
  commands.registerCommand("extraterm:window.show", commandShow);

  EtTerminal.registerCommands(extensionManager);
  TextCommandsRegisterCommands(extensionManager);
  EtViewerTab.registerCommands(extensionManager);

  extensionManager.getExtensionContextByName("internal-commands")._debugRegisteredCommands();
}

function startUpSessions(configDatabase: ConfigDatabase, extensionManager: ExtensionManager): void {
  const disposables = new DisposableHolder();

  const createSessionCommands = (sessionConfigs: SessionConfiguration[]): void => {
    const extensionContext = extensionManager.getExtensionContextByName("internal-commands");

    for (const session of sessionConfigs) {
      const args = {
        sessionUuid: session.uuid
      };
      const command = "extraterm:window.newTerminal?" + encodeURIComponent(JSON.stringify(args));
      const contrib: ExtensionCommandContribution = {
        command,
        title: "New Terminal: " + session.name,
        category: "window",
        order: 1000,
        when: "",
        icon: "fa fa-plus",
      };
      disposables.add(extensionContext._registerCommandContribution(contrib));

      extensionContext._setCommandMenu(command, "contextMenu", false);
      extensionContext._setCommandMenu(command, "commandPalette", true);
      extensionContext._setCommandMenu(command, "emptyPane", true);
      extensionContext._setCommandMenu(command, "newTerminal", true);
      extensionContext._setCommandMenu(command, "windowMenu", true);
    }
  };

  configDatabase.onChange(event => {
    if (event.key === SESSION_CONFIG) {
      disposables.dispose();
      createSessionCommands(event.newConfig);
    }
  });

  const sessionConfig = <SessionConfiguration[]> configDatabase.getSessionConfig();
  createSessionCommands(sessionConfig);
}

let developerToolMenuChecked = false;

function commandToggleDeveloperTools(): void {
  WebIpc.devToolsRequest( ! developerToolMenuChecked);
}

function customizeToggleDeveloperTools(): CustomizedCommand {
  return {
    checked: developerToolMenuChecked
  };
}

async function commandShow(): Promise<void> {
  await WebIpc.windowShowRequst();
}

function commandReloadThemeContents(): void {
  asyncReloadThemeContents();
}

function commandOpenCommandPalette(extensionManager: ExtensionManager, commandPalette: CommandPalette): void {
  const tab = extensionManager.getActiveTabContent();
  if (isSupportsDialogStack(tab)) {
    commandPalette.open(tab, tab);
  }
}

function commandNewWindow(): void {
  WebIpc.newWindow();
}

function handleDpiChange(mainWebUi: MainWebUi, dpi: number): void {
  const newTerminalVisualConfig = {
    ...terminalVisualConfig, devicePixelRatio: window.devicePixelRatio
  };
  terminalVisualConfig = newTerminalVisualConfig;
  mainWebUi.setTerminalVisualConfig(terminalVisualConfig);
}

function handleCloseWindow(mainWebUi: MainWebUi, msg: Messages.Message): void {
  mainWebUi.closeAllTabs();
  WebIpc.windowCloseRequest();
}

function handleThemeListMessage(mainWebUi: MainWebUi, msg: Messages.Message): void {
  const themesMessage = <Messages.ThemeListMessage> msg;
  mainWebUi.setThemes(themesMessage.themeInfo);
}

function handleThemeContentsMessage(msg: Messages.Message): void {
  const themeContentsMessage = <Messages.ThemeContentsMessage> msg;

  const cssFileMap = new Map<ThemeTypes.CssFile, string>();
  for (const renderedCssFile of themeContentsMessage.themeContents.cssFiles) {
    cssFileMap.set(renderedCssFile.id, renderedCssFile.contents);
  }

  if (themeContentsMessage.errorMessage !== "") {
    _log.warn(themeContentsMessage.errorMessage);
  }

  // Distribute the CSS files to the classes which want them.
  ThemeConsumer.updateCss(cssFileMap);
}

function handleDevToolsStatus(applicationContextMenu: ApplicationContextMenu, msg: Messages.Message): void {
  const devToolsStatusMessage = <Messages.DevToolsStatusMessage> msg;
  developerToolMenuChecked = devToolsStatusMessage.open;
  applicationContextMenu.render();
}

function handleClipboardRead(mainWebUi: MainWebUi, msg: Messages.Message): void {
  const clipboardReadMessage = <Messages.ClipboardReadMessage> msg;
  mainWebUi.pasteText(clipboardReadMessage.text);
}

//-------------------------------------------------------------------------
let oldSystemConfig: SystemConfig = null;
let oldGeneralConfig: GeneralConfig = null;

async function applyConfiguration(configDatabase: ConfigDatabase, keybindingsManager: KeybindingsManager,
    fontLoader: FontLoader, mainWebUi: MainWebUi): Promise<void> {

  const newSystemConfig = configDatabase.getSystemConfigCopy();
  const newGeneralConfig = configDatabase.getGeneralConfigCopy();

  if (newSystemConfig == null || newGeneralConfig == null) {
    // Not initialised yet. This can happen with the different (race) timing between main and render process.
    return;
  }

  const keybindingsFile = loadKeybindingsFromObject(newSystemConfig.flatKeybindingsSet, process.platform);
  if (! keybindingsFile.equals(keybindingsManager.getKeybindingsMapping())) {
    keybindingsManager.setKeybindingsMapping(keybindingsFile);
  }

  if (oldSystemConfig === null || oldGeneralConfig.uiScalePercent !== newGeneralConfig.uiScalePercent) {
    setRootFontScaleFactor(newGeneralConfig.uiScalePercent);
  }

  if (oldGeneralConfig === null || oldGeneralConfig.terminalFontSize !== newGeneralConfig.terminalFontSize ||
      oldGeneralConfig.terminalFont !== newGeneralConfig.terminalFont) {

    const matchingFonts = newSystemConfig.availableFonts.filter(
      (font) => font.postscriptName === newGeneralConfig.terminalFont);

    const fontSizePx = Math.max(5, newGeneralConfig.terminalFontSize);
    setCssVars(newGeneralConfig.terminalFont, fontSizePx);
    await fontLoader.loadFont(newGeneralConfig.terminalFont, matchingFonts[0].path);
  }

  if (oldGeneralConfig == null) {
    oldGeneralConfig = newGeneralConfig;
    oldSystemConfig = newSystemConfig;
    await asyncRequestThemeContents();
  } else {
    const refreshThemeTypeList: ThemeTypes.ThemeType[] = [];
    if (oldGeneralConfig.themeSyntax !== newGeneralConfig.themeSyntax) {
      refreshThemeTypeList.push("syntax");
    }

    if (oldGeneralConfig.themeGUI !== newGeneralConfig.themeGUI ||
        oldGeneralConfig.terminalMarginStyle !== newGeneralConfig.terminalMarginStyle ||
        oldGeneralConfig.windowBackgroundMode !== newGeneralConfig.windowBackgroundMode ||
        oldGeneralConfig.windowBackgroundTransparencyPercent !== newGeneralConfig.windowBackgroundTransparencyPercent ||
        oldGeneralConfig.themeTerminal !== newGeneralConfig.themeTerminal) {
      refreshThemeTypeList.push("gui");
    }

    if (oldGeneralConfig.themeTerminal !== newGeneralConfig.themeTerminal ||
        oldGeneralConfig.gpuDriverWorkaround !== newGeneralConfig.gpuDriverWorkaround) {
      refreshThemeTypeList.push("terminal");
    }

    if (refreshThemeTypeList.length !== 0) {
      await asyncRequestThemeContents(refreshThemeTypeList);
    }

    let terminalVisualConfigChanged = false;
    if (oldGeneralConfig.themeTerminal !== newGeneralConfig.themeTerminal) {
      await asyncLoadTerminalTheme(configDatabase, fontLoader);
      terminalVisualConfigChanged = true;
    }
    if (oldGeneralConfig.terminalFont !== newGeneralConfig.terminalFont ||
        oldGeneralConfig.terminalFontSize !== newGeneralConfig.terminalFontSize ||
        oldGeneralConfig.cursorStyle !== newGeneralConfig.cursorStyle ||
        oldGeneralConfig.blinkingCursor !== newGeneralConfig.blinkingCursor ||
        oldGeneralConfig.windowBackgroundMode !== newGeneralConfig.windowBackgroundMode ||
        oldGeneralConfig.terminalDisplayLigatures !== newGeneralConfig.terminalDisplayLigatures) {

      let ligatureMarker = terminalVisualConfig ? terminalVisualConfig.ligatureMarker : null;
      if (oldGeneralConfig.terminalFont !== newGeneralConfig.terminalFont ||
          oldGeneralConfig.terminalDisplayLigatures !== newGeneralConfig.terminalDisplayLigatures) {
        if (newGeneralConfig.terminalDisplayLigatures) {
          const fontFilePath = getFontFilePath(newSystemConfig.availableFonts, newGeneralConfig.terminalFont);
          ligatureMarker = await loadFontFile(fontFilePath);
        } else {
          ligatureMarker = null;
        }
      }

      terminalVisualConfig = {
        cursorStyle: newGeneralConfig.cursorStyle,
        cursorBlink: newGeneralConfig.blinkingCursor,
        fontFamily: fontLoader.cssNameFromFontName(newGeneralConfig.terminalFont),
        fontFilePath: getFontFilePath(newSystemConfig.availableFonts, newGeneralConfig.terminalFont),
        fontSizePx: newGeneralConfig.terminalFontSize,
        devicePixelRatio: window.devicePixelRatio,
        terminalTheme: terminalVisualConfig.terminalTheme,
        transparentBackground: newGeneralConfig.windowBackgroundMode !== "opaque",
        ligatureMarker,
        useLigatures: newGeneralConfig.terminalDisplayLigatures,
      };
      terminalVisualConfigChanged = true;
    }
    if (terminalVisualConfigChanged && mainWebUi != null) {
      mainWebUi.setTerminalVisualConfig(terminalVisualConfig);
    }
  }

  oldGeneralConfig = newGeneralConfig;
  oldSystemConfig = newSystemConfig;
}

function getFontFilePath(availableFonts: DeepReadonly<FontInfo[]>, fontFamily: string): string {
  for (const fontInfo of availableFonts) {
    if (fontFamily === fontInfo.postscriptName) {
      return fontInfo.path;
    }
  }
  return null;
}

async function asyncRequestThemeContents(refreshThemeTypeList: ThemeTypes.ThemeType[] = []): Promise<void> {
  const cssFileMap = new Map<ThemeTypes.CssFile, string>(ThemeConsumer.cssMap());

  const neededThemeTypes = new Set<ThemeTypes.ThemeType>(refreshThemeTypeList);
  if (refreshThemeTypeList.length === 0) {
    neededThemeTypes.add("terminal");
    neededThemeTypes.add("gui");
    neededThemeTypes.add("syntax");
  } else {
    if (refreshThemeTypeList.indexOf("terminal") !== -1) {
      // GUI theme can also depend on the terminal theme. Thus, rerender.
      neededThemeTypes.add("gui");
    }
  }

  for (const themeType of neededThemeTypes) {
    const renderResult = await WebIpc.requestThemeContents(themeType);
    if (renderResult.success) {
      for (const renderedCssFile of renderResult.themeContents.cssFiles) {
        cssFileMap.set(renderedCssFile.id, renderedCssFile.contents);
      }
    }
    if (renderResult.errorMessage !== "") {
      _log.warn(renderResult.errorMessage);
    }
  }

  // Distribute the CSS files to the classes which want them.
  ThemeConsumer.updateCss(cssFileMap);
}

function asyncReloadThemeContents(): Promise<void> {
  return asyncRequestThemeContents();
}

function setCssVars(fontName: string, terminalFontSizePx: number): void {
  const fontCssName = fontName.replace(/\W/g, "_");
  (<HTMLStyleElement> document.getElementById('CSS_VARS')).textContent =
    `
    :root {
      --default-terminal-font-size: ${terminalFontSizePx}px;
      --terminal-font: "${fontCssName}";
    }
    `;
}

function setRootFontScaleFactor(uiScalePercent: number): void {
  const unitHeightPx = 12;

  const rootFontSize = Math.max(Math.floor(unitHeightPx * uiScalePercent / 100), 5) + "px";
  _log.debug("uiScalePercent: ", uiScalePercent, " = rootFontSize: ",rootFontSize);
  window.document.documentElement.style.fontSize = rootFontSize;
}

function startUpCommandPalette(extensionManager: ExtensionManager,
    keybindingsManager: KeybindingsManager): CommandPalette {
  return new CommandPalette(extensionManager, keybindingsManager);
}

function startUpApplicationContextMenu(extensionManager: ExtensionManager,
    keybindingsManager: KeybindingsManager, mainWebUi: MainWebUi): ApplicationContextMenu {

  const applicationContextMenu = new ApplicationContextMenu(extensionManager, keybindingsManager);
  applicationContextMenu.onClose(() => enableWindowMoveArea(mainWebUi));

  mainWebUi.addEventListener(EVENT_CONTEXT_MENU_REQUEST, (ev: CustomEvent) => {
    extensionManager.updateExtensionWindowStateFromEvent(ev);
    disableWindowMoveArea(mainWebUi);
    applicationContextMenu.open(ev);
  });

  return applicationContextMenu;
}

class KeybindingsManagerImpl implements KeybindingsManager {
  private _log: Logger;
  #keybindingsMapping: TermKeybindingsMapping = null;
  #onChangeEventEmitter = new EventEmitter<void>();
  onChange: Event<void>;
  #enabled = true;

  constructor() {
    this._log = getLogger("KeybindingsManagerImpl", self);
    this.onChange = this.#onChangeEventEmitter.event;
  }

  getKeybindingsMapping(): TermKeybindingsMapping {
    return this.#keybindingsMapping;
  }

  setKeybindingsMapping(newKeybindingContexts: TermKeybindingsMapping): void {
    this.#keybindingsMapping = newKeybindingContexts;
    this.#keybindingsMapping.setEnabled(this.#enabled);
    this.#onChangeEventEmitter.fire(undefined);
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (this.#keybindingsMapping != null) {
      this.#keybindingsMapping.setEnabled(this.#enabled);
    }

    WebIpc.enableGlobalKeybindings(enabled);
  }
}
