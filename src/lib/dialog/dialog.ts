import {Injector, ComponentRef, Injectable, Optional, SkipSelf, TemplateRef} from '@angular/core';
import {Location} from '@angular/common';
import {Observable} from 'rxjs/Observable';
import {Subject} from 'rxjs/Subject';
import {Overlay, OverlayRef, ComponentType, OverlayState, ComponentPortal} from '../core';
import {extendObject} from '../core/util/object-extend';
import {ESCAPE} from '../core/keyboard/keycodes';
import {DialogInjector} from './dialog-injector';
import {MdDialogConfig} from './dialog-config';
import {MdDialogRef} from './dialog-ref';
import {MdDialogContainer} from './dialog-container';
import {TemplatePortal} from '../core/portal/portal';
import {BlockScrollStrategy} from '../core/overlay/scroll/block-scroll-strategy';
import {ViewportRuler} from '../core/overlay/position/viewport-ruler';
import 'rxjs/add/operator/first';


/**
 * Service to open Material Design modal dialogs.
 */
@Injectable()
export class MdDialog {
  private _openDialogsAtThisLevel: MdDialogRef<any>[] = [];
  private _afterAllClosedAtThisLevel = new Subject<void>();
  private _afterOpenAtThisLevel = new Subject<MdDialogRef<any>>();
  private _boundKeydown = this._handleKeydown.bind(this);

  /** Keeps track of the currently-open dialogs. */
  get _openDialogs(): MdDialogRef<any>[] {
    return this._parentDialog ? this._parentDialog._openDialogs : this._openDialogsAtThisLevel;
  }

  /** Subject for notifying the user that a dialog has opened. */
  get _afterOpen(): Subject<MdDialogRef<any>> {
    return this._parentDialog ? this._parentDialog._afterOpen : this._afterOpenAtThisLevel;
  }

  /** Subject for notifying the user that all open dialogs have finished closing. */
  get _afterAllClosed(): Subject<void> {
    return this._parentDialog ?
      this._parentDialog._afterAllClosed : this._afterAllClosedAtThisLevel;
  }

  /** Gets an observable that is notified when a dialog has been opened. */
  afterOpen: Observable<MdDialogRef<any>> = this._afterOpen.asObservable();

  /** Gets an observable that is notified when all open dialog have finished closing. */
  afterAllClosed: Observable<void> = this._afterAllClosed.asObservable();

  constructor(
      private _overlay: Overlay,
      private _injector: Injector,
      private _viewportRuler: ViewportRuler,
      @Optional() private _location: Location,
      @Optional() @SkipSelf() private _parentDialog: MdDialog) {

    // Close all of the dialogs when the user goes forwards/backwards in history or when the
    // location hash changes. Note that this usually doesn't include clicking on links (unless
    // the user is using the `HashLocationStrategy`).
    if (!_parentDialog && _location) {
      _location.subscribe(() => this.closeAll());
    }
  }

  /**
   * Opens a modal dialog containing the given component.
   * @param componentOrTemplateRef Type of the component to load into the dialog,
   *     or a TemplateRef to instantiate as the dialog content.
   * @param config Extra configuration options.
   * @returns Reference to the newly-opened dialog.
   */
  open<T>(componentOrTemplateRef: ComponentType<T> | TemplateRef<T>,
          config?: MdDialogConfig): MdDialogRef<T> {
    config = _applyConfigDefaults(config);

    let overlayRef = this._createOverlay(config);
    let dialogContainer = this._attachDialogContainer(overlayRef, config);
    let dialogRef =
        this._attachDialogContent(componentOrTemplateRef, dialogContainer, overlayRef, config);

    if (!this._openDialogs.length) {
      document.addEventListener('keydown', this._boundKeydown);
    }

    this._openDialogs.push(dialogRef);
    dialogRef.afterClosed().subscribe(() => this._removeOpenDialog(dialogRef));
    this._afterOpen.next(dialogRef);

    return dialogRef;
  }

  /**
   * Closes all of the currently-open dialogs.
   */
  closeAll(): void {
    let i = this._openDialogs.length;

    while (i--) {
      // The `_openDialogs` property isn't updated after close until the rxjs subscription
      // runs on the next microtask, in addition to modifying the array as we're going
      // through it. We loop through all of them and call close without assuming that
      // they'll be removed from the list instantaneously.
      this._openDialogs[i].close();
    }
  }

  /**
   * Creates the overlay into which the dialog will be loaded.
   * @param config The dialog configuration.
   * @returns A promise resolving to the OverlayRef for the created overlay.
   */
  private _createOverlay(config: MdDialogConfig): OverlayRef {
    let overlayState = this._getOverlayState(config);
    return this._overlay.create(overlayState);
  }

  /**
   * Creates an overlay state from a dialog config.
   * @param dialogConfig The dialog configuration.
   * @returns The overlay configuration.
   */
  private _getOverlayState(dialogConfig: MdDialogConfig): OverlayState {
    let overlayState = new OverlayState();
    overlayState.panelClass = dialogConfig.panelClass;
    overlayState.hasBackdrop = dialogConfig.hasBackdrop;
    overlayState.scrollStrategy = new BlockScrollStrategy(this._viewportRuler);
    if (dialogConfig.backdropClass) {
      overlayState.backdropClass = dialogConfig.backdropClass;
    }
    overlayState.positionStrategy = this._overlay.position().global();

    return overlayState;
  }

  /**
   * Attaches an MdDialogContainer to a dialog's already-created overlay.
   * @param overlay Reference to the dialog's underlying overlay.
   * @param config The dialog configuration.
   * @returns A promise resolving to a ComponentRef for the attached container.
   */
  private _attachDialogContainer(overlay: OverlayRef, config: MdDialogConfig): MdDialogContainer {
    let viewContainer = config ? config.viewContainerRef : null;
    let containerPortal = new ComponentPortal(MdDialogContainer, viewContainer);

    let containerRef: ComponentRef<MdDialogContainer> = overlay.attach(containerPortal);
    containerRef.instance.dialogConfig = config;

    return containerRef.instance;
  }

  /**
   * Attaches the user-provided component to the already-created MdDialogContainer.
   * @param componentOrTemplateRef The type of component being loaded into the dialog,
   *     or a TemplateRef to instantiate as the content.
   * @param dialogContainer Reference to the wrapping MdDialogContainer.
   * @param overlayRef Reference to the overlay in which the dialog resides.
   * @param config The dialog configuration.
   * @returns A promise resolving to the MdDialogRef that should be returned to the user.
   */
  private _attachDialogContent<T>(
      componentOrTemplateRef: ComponentType<T> | TemplateRef<T>,
      dialogContainer: MdDialogContainer,
      overlayRef: OverlayRef,
      config: MdDialogConfig): MdDialogRef<T> {
    // Create a reference to the dialog we're creating in order to give the user a handle
    // to modify and close it.

    let dialogRef = new MdDialogRef<T>(overlayRef, dialogContainer);

    if (!config.disableClose) {
      // When the dialog backdrop is clicked, we want to close it.
      overlayRef.backdropClick().first().subscribe(() => dialogRef.close());
    }

    // We create an injector specifically for the component we're instantiating so that it can
    // inject the MdDialogRef. This allows a component loaded inside of a dialog to close itself
    // and, optionally, to return a value.
    let userInjector = config && config.viewContainerRef && config.viewContainerRef.injector;
    let dialogInjector = new DialogInjector(userInjector || this._injector, dialogRef, config.data);

    if (componentOrTemplateRef instanceof TemplateRef) {
      dialogContainer.attachTemplatePortal(new TemplatePortal(componentOrTemplateRef, null));
    } else {
      let contentRef = dialogContainer.attachComponentPortal(
          new ComponentPortal(componentOrTemplateRef, null, dialogInjector));
      dialogRef.componentInstance = contentRef.instance;
    }

    dialogRef
      .updateSize(config.width, config.height)
      .updatePosition(config.position);

    return dialogRef;
  }

  /**
   * Removes a dialog from the array of open dialogs.
   * @param dialogRef Dialog to be removed.
   */
  private _removeOpenDialog(dialogRef: MdDialogRef<any>) {
    let index = this._openDialogs.indexOf(dialogRef);

    if (index > -1) {
      this._openDialogs.splice(index, 1);

      // no open dialogs are left, call next on afterAllClosed Subject
      if (!this._openDialogs.length) {
        this._afterAllClosed.next();
        document.removeEventListener('keydown', this._boundKeydown);
      }
    }
  }

  /**
   * Handles global key presses while there are open dialogs. Closes the
   * top dialog when the user presses escape.
   */
  private _handleKeydown(event: KeyboardEvent): void {
    let topDialog = this._openDialogs[this._openDialogs.length - 1];
    let canClose = topDialog ? !topDialog._containerInstance.dialogConfig.disableClose : false;

    if (event.keyCode === ESCAPE && canClose) {
      topDialog.close();
    }
  }
}

/**
 * Applies default options to the dialog config.
 * @param config Config to be modified.
 * @returns The new configuration object.
 */
function _applyConfigDefaults(config: MdDialogConfig): MdDialogConfig {
  return extendObject(new MdDialogConfig(), config);
}
