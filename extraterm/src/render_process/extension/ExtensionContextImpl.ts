/*
 * Copyright 2020 Simon Edwards <simon@simonzone.com>
 *
 * This source code is licensed under the MIT license which is detailed in the LICENSE.txt file.
 */
import * as _ from "lodash";
import * as ExtensionApi from "@extraterm/extraterm-extension-api";
import * as Ace from "@extraterm/ace-ts";

import { Logger, getLogger, log } from "extraterm-logging";
import { EtTerminal } from "../Terminal";
import { ProxyFactoryImpl } from "./ProxyFactoryImpl";
import { ExtensionManager, InternalExtensionContext, InternalWindow, ProxyFactory, InternalTabTitleWidget
} from "./InternalTypes";
import { WindowProxy } from "./proxy/WindowProxy";
import { ExtensionMetadata, ExtensionCommandContribution, ExtensionMenusContribution } from "../../ExtensionMetadata";
import { CommandsRegistry } from "./CommandsRegistry";
import { CommonExtensionWindowState } from "./CommonExtensionState";
import { ExtensionContainerElement } from "./ExtensionContainerElement";
import { ApplicationImpl } from "./ApplicationImpl";
import { ConfigurationImpl } from "../../extension/ConfigurationImpl";
import { ConfigDatabase } from "../../ConfigDatabase";


export class ExtensionContextImpl implements InternalExtensionContext, ExtensionApi.Disposable {
  private _log: Logger = null;

  application: ApplicationImpl = null;
  commands: CommandsRegistry = null;
  configuration: ConfigurationImpl = null;
  window: ExtensionApi.Window = null;
  _internalWindow: InternalWindow = null;
  aceModule: typeof Ace = Ace;
  logger: ExtensionApi.Logger = null;
  isBackendProcess = false;

  _proxyFactory: ProxyFactory = null;

  extensionPath: string = null;

  _extensionManager: ExtensionManager;
  _extensionMetadata: ExtensionMetadata;

  #tabTitleWidgetFactoryMap = new Map<string, ExtensionApi.TabTitleWidgetFactory>();

  constructor(extensionManager: ExtensionManager, extensionMetadata: ExtensionMetadata, configDatabase: ConfigDatabase,
              commonExtensionState: CommonExtensionWindowState, applicationVersion: string) {

    this._log = getLogger("InternalExtensionContextImpl", this);

    this._extensionManager = extensionManager;
    this._extensionMetadata = extensionMetadata;
    this._proxyFactory = new ProxyFactoryImpl(this);
    this.application = new ApplicationImpl(applicationVersion);
    this.commands = new CommandsRegistry(this, extensionMetadata.name,
                                          extensionMetadata.contributes.commands, extensionMetadata.contributes.menus);
    this._internalWindow = new WindowProxy(this, commonExtensionState);
    this.window = this._internalWindow;

    this.extensionPath = this._extensionMetadata.path;
    this.configuration = new ConfigurationImpl(configDatabase, extensionMetadata.name);
    this.logger = getLogger(extensionMetadata.name);
  }

  dispose() {
    this.configuration.dispose();
  }

  get backend(): never {
    this.logger.warn("'ExtensionContext.backend' is not available from a render process.");
    throw Error("'ExtensionContext.backend' is not available from a render process.");
  }

  _findViewerElementTagByMimeType(mimeType: string): string {
    return this._internalWindow.findViewerElementTagByMimeType(mimeType);
  }

  _debugRegisteredCommands(): void {
    for (const command of this._extensionMetadata.contributes.commands) {
      if (this.commands.getCommandFunction(command.command) == null) {
        this._log.debug(`Command '${command.command}' from extension '${this._extensionMetadata.name}' has no function registered.`);
      }
    }
  }

  _registerCommandContribution(contribution: ExtensionCommandContribution): ExtensionApi.Disposable {
    this._extensionMetadata.contributes.commands.push(contribution);
    const commandDisposable = this.commands.registerCommandContribution(contribution);
    this._extensionManager.commandRegistrationChanged();
    return {
      dispose: () => {
        this._extensionManager.commandRegistrationChanged();
        commandDisposable.dispose();
        const index = this._extensionMetadata.contributes.commands.indexOf(contribution);
        this._extensionMetadata.contributes.commands.splice(index, 1);
      }
    };
  }

  _setCommandMenu(command: string, menuType: keyof ExtensionMenusContribution, on: boolean): void {
    const entryList = this.commands._commandToMenuEntryMap.get(command);
    if (entryList == null) {
      return;
    }
    for (const entry of entryList) {
      entry[menuType] = on;
    }
  }

  _registerTabTitleWidget(name: string, factory: ExtensionApi.TabTitleWidgetFactory): void {
    const tabTitleWidgetMeta = this._extensionMetadata.contributes.tabTitleWidgets;
    for (const data of tabTitleWidgetMeta) {
      if (data.name === name) {
        this.#tabTitleWidgetFactoryMap.set(name, factory);
        return;
      }
    }

    this.logger.warn(
      `Unknown tab title widget '${name}' given to registerTabTitleWidget().`);
  }

  _createTabTitleWidgets(terminal: EtTerminal): HTMLElement[] {
    const tabTitleWidgetsContrib = this._extensionMetadata.contributes.tabTitleWidgets;
    const result: HTMLElement[] = [];
    for (const contrib of tabTitleWidgetsContrib) {
      const factory = this.#tabTitleWidgetFactoryMap.get(contrib.name);
      if (factory != null) {
        const extensionContainerElement = <ExtensionContainerElement>
          document.createElement(ExtensionContainerElement.TAG_NAME);
        extensionContainerElement._setExtensionContext(this);
        extensionContainerElement._setExtensionCss(contrib.css);

        const tabTitleWidget = new TabTitleWidgetImpl(extensionContainerElement);
        const factoryResult = factory(this._proxyFactory.getTerminalProxy(terminal), tabTitleWidget);
// FIXME record this stuff somewhere, and also may be clean it up.
        result.push(extensionContainerElement);
      }
    }
    return result;
  }
}

class TabTitleWidgetImpl implements InternalTabTitleWidget {

  constructor(private _extensionContainerElement: ExtensionContainerElement) {
  }

  getContainerElement(): HTMLElement {
    return this._extensionContainerElement.getContainerElement();
  }
}
