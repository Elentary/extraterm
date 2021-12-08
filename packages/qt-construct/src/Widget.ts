/*
 * Copyright 2021 Simon Edwards <simon@simonzone.com>
 *
 * This source code is licensed under the MIT license which is detailed in the LICENSE.txt file.
 */
import { ContextMenuPolicy, FocusPolicy, NodeLayout, NodeWidget, QSizePolicyPolicy, QWidget, WidgetAttribute, WidgetEventTypes, WindowType
} from "@nodegui/nodegui";

export interface WidgetOptions {
  attribute?: WidgetAttribute[];
  enabled?: boolean;
  id?: string;
  layout?: NodeLayout<any>;
  cssClass?: string | string[];
  windowTitle?: string;
  focusPolicy?: FocusPolicy;
  onEnter?: () => void;
  onLayoutRequest?: () => void;
  onLeave?: () => void;
  onKeyPress?: (nativeEvent /* NativeQEvent */) => void;
  onResize?: (native /* NativeQEvent */) => void;
  windowFlag?: WindowType;
  sizePolicy?: {horizontal: QSizePolicyPolicy, vertical: QSizePolicyPolicy};
  maximumHeight?: number;
  maximumWidth?: number;
  minimumHeight?: number;
  minimumWidth?: number;
  inlineStyle?: string;
  contextMenuPolicy?: ContextMenuPolicy.PreventContextMenu;
}

export function ApplyWidgetOptions(widget: NodeWidget<any>, options: WidgetOptions): void {
  const {
    attribute, contextMenuPolicy, enabled, id, cssClass, focusPolicy, layout, onEnter, onLayoutRequest, onLeave,
    onKeyPress, onResize, sizePolicy, windowTitle, maximumHeight, maximumWidth, minimumHeight, minimumWidth,
    windowFlag, inlineStyle
  } = options;

  if (enabled !== undefined) {
    widget.setEnabled(enabled);
  }
  if (attribute !== undefined) {
    for (const attr of attribute) {
      widget.setAttribute(attr, true);
    }
  }
  if (id !== undefined) {
    widget.setObjectName(id);
  }
  if (layout !== undefined) {
    widget.setLayout(layout);
  }
  if (cssClass !== undefined) {
    widget.setProperty("cssClass", typeof cssClass === "string" ? [cssClass] : cssClass);
  }
  if (windowTitle !== undefined) {
    widget.setWindowTitle(windowTitle);
  }
  if (focusPolicy !== undefined) {
    widget.setFocusPolicy(focusPolicy);
  }
  if (onKeyPress !== undefined) {
    widget.addEventListener(WidgetEventTypes.KeyPress, onKeyPress);
  }
  if (onEnter !== undefined) {
    widget.addEventListener(WidgetEventTypes.Enter, onEnter);
  }
  if (onLayoutRequest !== undefined) {
    widget.addEventListener(WidgetEventTypes.LayoutRequest, onLayoutRequest);
  }
  if (onLeave !== undefined) {
    widget.addEventListener(WidgetEventTypes.Leave, onLeave);
  }
  if (onResize !== undefined) {
    widget.addEventListener(WidgetEventTypes.Resize, onResize);
  }
  if (windowFlag !== undefined) {
    widget.setWindowFlag(windowFlag, true);
  }
  if (maximumHeight !== undefined) {
    widget.setMaximumHeight(maximumHeight);
  }
  if (maximumWidth !== undefined) {
    widget.setMaximumWidth(maximumWidth);
  }
  if (minimumHeight !== undefined) {
    widget.setMinimumHeight(minimumHeight);
  }
  if (minimumWidth !== undefined) {
    widget.setMinimumWidth(minimumWidth);
  }
  if (sizePolicy !== undefined) {
    widget.setSizePolicy(sizePolicy.horizontal, sizePolicy.vertical);
  }
  if (inlineStyle !== undefined ) {
    widget.setInlineStyle(inlineStyle);
  }
  if (contextMenuPolicy !== undefined) {
    widget.setContextMenuPolicy(contextMenuPolicy);
  }
}

export function Widget(options: WidgetOptions): QWidget {
  const widget = new QWidget();
  ApplyWidgetOptions(widget, options);
  return widget;
}
