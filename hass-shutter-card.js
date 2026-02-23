// Constants
const SLIDER_MIN_PX = 19;
const SLIDER_MAX_PX = 137;
const SLIDER_RANGE_PX = SLIDER_MAX_PX - SLIDER_MIN_PX;
const DEFAULT_WIDTH_PX = 153;
const DEFAULT_BUTTONS_POSITION = 'left';
const VALID_BUTTONS_POSITIONS = ['left', 'top', 'bottom', 'right'];
const VALID_TITLE_POSITIONS = ['top', 'bottom', 'hide'];

/**
 * Normalize entity config from string or object form.
 * Handles both "cover.my_shutter" and { entity: "cover.my_shutter", ... } formats.
 * All values have proper types and defaults applied.
 */
function normalizeEntityConfig(entity) {
  if (typeof entity === 'string') {
    return {
      entity: entity,
      name: undefined,
      buttonsPosition: DEFAULT_BUTTONS_POSITION,
      titlePosition: 'top',
      invertPercentage: false,
      canTilt: false,
      partialClosePercentage: 0,
      offsetClosedPercentage: 0,
      alwaysPercentage: false,
      shutterWidthPx: DEFAULT_WIDTH_PX,
      disableEndButtons: false,
      showButtons: true,
      showSlidePercentage: true,
    };
  }

  const bp = entity.buttons_position ? entity.buttons_position.toLowerCase() : DEFAULT_BUTTONS_POSITION;
  const tp = entity.title_position ? entity.title_position.toLowerCase() : 'top';

  return {
    entity: entity.entity,
    name: entity.name || undefined,
    buttonsPosition: VALID_BUTTONS_POSITIONS.includes(bp) ? bp : DEFAULT_BUTTONS_POSITION,
    titlePosition: VALID_TITLE_POSITIONS.includes(tp) ? tp : 'top',
    invertPercentage: !!entity.invert_percentage,
    canTilt: !!entity.can_tilt,
    partialClosePercentage: Math.max(0, Math.min(100, entity.partial_close_percentage || 0)),
    offsetClosedPercentage: Math.max(0, Math.min(100, entity.offset_closed_percentage || 0)),
    alwaysPercentage: !!entity.always_percentage,
    shutterWidthPx: Math.max(10, entity.shutter_width_px || DEFAULT_WIDTH_PX),
    disableEndButtons: !!entity.disable_end_buttons,
    showButtons: entity.show_buttons !== false,
    showSlidePercentage: entity.show_slide_percentage !== false,
  };
}

/**
 * Convert raw HA position to visible percentage accounting for offset.
 * Guards against division by zero when offset == 100.
 */
function rawToVisiblePercent(rawPercent, inverted, offset) {
  if (typeof rawPercent !== 'number') return 0;
  if (offset === 0) return rawPercent;

  if (inverted) {
    return Math.min(100, Math.round((rawPercent / offset) * 100));
  }

  const divisor = 100 - offset;
  if (divisor === 0) return 0;
  return Math.max(0, Math.round(((rawPercent - offset) / divisor) * 100));
}

/**
 * Convert a percentage to a pixel position for the slider.
 */
function percentToPixelPosition(percent, inverted, offset) {
  const visible = rawToVisiblePercent(percent, inverted, offset);
  const fraction = inverted ? visible : 100 - visible;
  return (SLIDER_RANGE_PX * fraction) / 100 + SLIDER_MIN_PX;
}

/**
 * Convert a pixel position back to a raw cover percentage for service calls.
 */
function pixelToRawPercent(pixelPosition, inverted, offset) {
  const clamped = Math.max(SLIDER_MIN_PX, Math.min(SLIDER_MAX_PX, pixelPosition));
  const fraction = ((clamped - SLIDER_MIN_PX) / SLIDER_RANGE_PX) * (100 - offset);
  return Math.round(inverted ? fraction : 100 - fraction);
}

function clampPosition(position) {
  return Math.max(SLIDER_MIN_PX, Math.min(SLIDER_MAX_PX, position));
}

// Card picker registration
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'shutter-card',
  name: 'Shutter Card',
  description: 'A card to control shutters, blinds and covers',
  preview: false,
});

class ShutterCard extends HTMLElement {
  set hass(hass) {
    const entities = this._entities;

    // Init the card (first render only)
    if (!this.card) {
      this._initCard(hass, entities);
    }

    // Update all shutters UI
    entities.forEach((cfg) => {
      const shutter = this.card.querySelector('div[data-shutter="' + cfg.entity + '"]');
      if (!shutter) return;

      const slide = shutter.querySelector('.sc-shutter-selector-slide');
      const picker = shutter.querySelector('.sc-shutter-selector-picker');
      const floatingPosition = shutter.querySelector('.sc-shutter-floating-position');

      const state = hass.states[cfg.entity];
      const friendlyName = cfg.name || (state ? state.attributes.friendly_name : cfg.entity);
      const currentPosition = state ? state.attributes.current_position : undefined;
      const movementState = state ? state.state : 'unavailable';
      const isUnavailable = !state || state.state === 'unavailable' || state.state === 'unknown';

      // Update labels (textContent for XSS safety)
      shutter.querySelectorAll('.sc-shutter-label').forEach((label) => {
        label.textContent = friendlyName;
      });

      // Handle unavailable state
      if (isUnavailable) {
        shutter.querySelectorAll('.sc-shutter-position').forEach((pos) => {
          pos.textContent = state ? state.state : 'unavailable';
        });
        shutter.classList.add('sc-unavailable');
        shutter.querySelectorAll('.sc-shutter-button').forEach((btn) => {
          btn.disabled = true;
        });
        return;
      }

      shutter.classList.remove('sc-unavailable');

      if (!this.isUpdating) {
        const visiblePosition = rawToVisiblePercent(currentPosition, cfg.invertPercentage, cfg.offsetClosedPercentage);
        let positionText = this._positionPercentToText(visiblePosition, cfg.invertPercentage, cfg.alwaysPercentage, hass);

        // Show extra detail when at end position with offset
        if (cfg.offsetClosedPercentage) {
          const atEnd = cfg.invertPercentage ? visiblePosition === 100 : visiblePosition === 0;
          if (atEnd) {
            const detail = 100 - Math.round(Math.abs(currentPosition - visiblePosition) / cfg.offsetClosedPercentage * 100);
            positionText += ' (' + detail + ' %)';
          }
        }

        shutter.querySelectorAll('.sc-shutter-position').forEach((pos) => {
          pos.textContent = positionText;
        });

        if (cfg.disableEndButtons && cfg.showButtons) {
          this._updateButtonStates(shutter, currentPosition, cfg.invertPercentage);
        }

        if (floatingPosition && typeof currentPosition === 'number') {
          floatingPosition.textContent = currentPosition + '%';
        }

        // Update slider position
        if (typeof currentPosition === 'number') {
          const pixelPos = percentToPixelPosition(currentPosition, cfg.invertPercentage, cfg.offsetClosedPercentage);
          this._setPickerPosition(clampPosition(pixelPos), picker, slide);
        }

        // Update movement overlay
        this._setMovement(movementState, shutter);
      }

      // Update ARIA attributes on picker
      if (typeof currentPosition === 'number') {
        picker.setAttribute('aria-valuenow', String(currentPosition));
        picker.setAttribute('aria-valuetext', currentPosition + '%');
      }
    });
  }

  _initCard(hass, entities) {
    const card = document.createElement('ha-card');
    if (this.config.title) {
      card.header = this.config.title;
    }
    this.card = card;
    this.appendChild(card);

    const allShutters = document.createElement('div');
    allShutters.className = 'sc-shutters';

    entities.forEach((cfg) => {
      const buttonsInRow = cfg.buttonsPosition === 'top' || cfg.buttonsPosition === 'bottom';
      const buttonsReversed = cfg.buttonsPosition === 'bottom' || cfg.buttonsPosition === 'right';

      const shutter = document.createElement('div');
      shutter.className = 'sc-shutter';
      shutter.dataset.shutter = cfg.entity;

      // Build buttons HTML
      const partialBtn = cfg.partialClosePercentage
        ? `<ha-icon-button label="Partially close" class="sc-shutter-button sc-shutter-button-partial" data-command="partial" data-position="${cfg.partialClosePercentage}"><ha-icon icon="mdi:arrow-expand-vertical"></ha-icon></ha-icon-button>`
        : '';

      const tiltBtns = cfg.canTilt
        ? `<ha-icon-button label="${hass.localize('ui.dialogs.more_info_control.cover.open_tilt_cover') || 'Open tilt'}" class="sc-shutter-button sc-shutter-button-tilt-open" data-command="tilt-open"><ha-icon icon="mdi:arrow-top-right"></ha-icon></ha-icon-button>
           <ha-icon-button label="${hass.localize('ui.dialogs.more_info_control.cover.close_tilt_cover') || 'Close tilt'}" class="sc-shutter-button sc-shutter-button-tilt-down" data-command="tilt-close"><ha-icon icon="mdi:arrow-bottom-left"></ha-icon></ha-icon-button>`
        : '';

      const mainBtns = cfg.showButtons
        ? `<div class="sc-shutter-buttons" style="flex-flow: ${buttonsInRow ? 'row' : 'column'} wrap;">
             <ha-icon-button label="${hass.localize('ui.dialogs.more_info_control.cover.open_cover') || 'Open'}" class="sc-shutter-button sc-shutter-button-up" data-command="up"><ha-icon icon="mdi:arrow-up"></ha-icon></ha-icon-button>
             <ha-icon-button label="${hass.localize('ui.dialogs.more_info_control.cover.stop_cover') || 'Stop'}" class="sc-shutter-button sc-shutter-button-stop" data-command="stop"><ha-icon icon="mdi:stop"></ha-icon></ha-icon-button>
             <ha-icon-button label="${hass.localize('ui.dialogs.more_info_control.cover.close_cover') || 'Close'}" class="sc-shutter-button sc-shutter-button-down" data-command="down"><ha-icon icon="mdi:arrow-down"></ha-icon></ha-icon-button>
           </div>`
        : '';

      const partialIndicator = cfg.partialClosePercentage && !cfg.offsetClosedPercentage
        ? `<div class="sc-shutter-selector-partial" style="top:${percentToPixelPosition(cfg.partialClosePercentage, cfg.invertPercentage, cfg.offsetClosedPercentage)}px"></div>`
        : '';

      const hideTop = cfg.titlePosition === 'bottom' || cfg.titlePosition === 'hide';
      const hideBottom = cfg.titlePosition !== 'bottom' || cfg.titlePosition === 'hide';

      shutter.innerHTML = `
        <div class="sc-shutter-top" ${hideTop ? 'style="display:none;"' : ''}>
          <div class="sc-shutter-label"></div>
          <div class="sc-shutter-position"></div>
        </div>
        <div class="sc-shutter-middle" style="flex-flow: ${buttonsInRow ? 'column' : 'row'}${buttonsReversed ? '-reverse' : ''} nowrap;">
          <div class="sc-shutter-buttons" style="flex-flow: ${buttonsInRow ? 'row' : 'column'} wrap;">
            ${partialBtn}
            ${tiltBtns}
          </div>
          ${mainBtns}
          <div class="sc-shutter-selector">
            <div class="sc-shutter-selector-picture" style="width: ${cfg.shutterWidthPx}px">
              <div class="sc-shutter-selector-slide">
                <div class="sc-shutter-floating-position"></div>
              </div>
              <div class="sc-shutter-selector-picker"
                   tabindex="0"
                   role="slider"
                   aria-label="Shutter position"
                   aria-valuemin="0"
                   aria-valuemax="100"
                   aria-valuenow="0"></div>
              ${partialIndicator}
              <div class="sc-shutter-movement-overlay">
                <ha-icon class="sc-shutter-movement-open" icon="mdi:arrow-up"></ha-icon>
                <ha-icon class="sc-shutter-movement-close" icon="mdi:arrow-down"></ha-icon>
              </div>
            </div>
          </div>
        </div>
        <div class="sc-shutter-bottom" ${hideBottom ? 'style="display:none;"' : ''}>
          <div class="sc-shutter-label"></div>
          <div class="sc-shutter-position"></div>
        </div>
      `;

      const picture = shutter.querySelector('.sc-shutter-selector-picture');
      const slide = shutter.querySelector('.sc-shutter-selector-slide');
      const picker = shutter.querySelector('.sc-shutter-selector-picker');
      const floatingPosition = shutter.querySelector('.sc-shutter-floating-position');

      // Click on label opens more-info dialog
      shutter.querySelectorAll('.sc-shutter-label').forEach((labelDOM) => {
        labelDOM.addEventListener('click', () => {
          const e = new CustomEvent('hass-more-info', { composed: true, bubbles: true, detail: { entityId: cfg.entity } });
          this.dispatchEvent(e);
        });
      });

      // Drag handling - pointer events only
      let initialPointerY = 0;
      let initialPickerTop = 0;

      const onPointerDown = (event) => {
        if (event.cancelable) event.preventDefault();
        this.isUpdating = true;
        initialPointerY = event.pageY;
        initialPickerTop = parseInt(picker.style.top) || SLIDER_MIN_PX;

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);

        if (cfg.showSlidePercentage && floatingPosition) {
          floatingPosition.style.display = 'block';
        }
      };

      const onPointerMove = (event) => {
        const delta = event.pageY - initialPointerY;
        const newPos = clampPosition(initialPickerTop + delta);
        this._setPickerPosition(newPos, picker, slide);

        if (cfg.showSlidePercentage && floatingPosition) {
          floatingPosition.textContent = pixelToRawPercent(newPos, cfg.invertPercentage, cfg.offsetClosedPercentage) + '%';
        }
      };

      const onPointerUp = (event) => {
        this.isUpdating = false;
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);

        if (cfg.showSlidePercentage && floatingPosition) {
          floatingPosition.style.display = 'none';
        }

        const delta = event.pageY - initialPointerY;
        const finalPos = clampPosition(initialPickerTop + delta);
        const percent = pixelToRawPercent(finalPos, cfg.invertPercentage, cfg.offsetClosedPercentage);

        this._callService(hass, 'set_cover_position', cfg.entity, { position: percent });
      };

      // Attach pointer events on picture area (larger hit target)
      picture.addEventListener('pointerdown', onPointerDown);

      // Keyboard support for slider
      picker.addEventListener('keydown', (event) => {
        const state = hass.states[cfg.entity];
        if (!state || typeof state.attributes.current_position !== 'number') return;

        const current = state.attributes.current_position;
        const step = event.shiftKey ? 10 : 1;
        let newPos = null;

        switch (event.key) {
          case 'ArrowUp':
          case 'ArrowRight':
            newPos = Math.min(100, current + (cfg.invertPercentage ? -step : step));
            break;
          case 'ArrowDown':
          case 'ArrowLeft':
            newPos = Math.max(0, current + (cfg.invertPercentage ? step : -step));
            break;
          case 'Home':
            newPos = cfg.invertPercentage ? 0 : 100;
            break;
          case 'End':
            newPos = cfg.invertPercentage ? 100 : 0;
            break;
          default:
            return;
        }
        event.preventDefault();
        if (newPos !== null) {
          this._callService(hass, 'set_cover_position', cfg.entity, { position: newPos });
        }
      });

      // Button click handling
      shutter.querySelectorAll('.sc-shutter-button').forEach((button) => {
        button.addEventListener('click', () => {
          const command = button.dataset.command;
          const serviceMap = {
            up: 'open_cover',
            down: 'close_cover',
            stop: 'stop_cover',
            partial: 'set_cover_position',
            'tilt-open': 'open_cover_tilt',
            'tilt-close': 'close_cover_tilt',
          };
          const service = serviceMap[command];
          if (!service) return;

          const args = command === 'partial' ? { position: Number(button.dataset.position) } : {};
          this._callService(hass, service, cfg.entity, args);
        });
      });

      allShutters.appendChild(shutter);
    });

    // Styles
    const style = document.createElement('style');
    style.textContent = `
      .sc-shutters { padding: 16px; }
      .sc-shutter { margin-top: 1rem; overflow: hidden; }
      .sc-shutter:first-child { margin-top: 0; }
      .sc-shutter.sc-unavailable { opacity: 0.5; pointer-events: none; }
      .sc-shutter-middle { display: flex; width: fit-content; max-width: 100%; margin: auto; }
      .sc-shutter-buttons { flex: 1; text-align: center; margin-top: 0.4rem; display: flex; max-width: 100%; }
      .sc-shutter-buttons ha-icon-button { display: block; width: min-content; }
      .sc-shutter-selector { flex: 1; }
      .sc-shutter-selector-partial { position: absolute; top: 0; left: 9px; width: 88%; height: 1px; background-color: var(--secondary-text-color, gray); }
      .sc-shutter-selector-picture {
        position: relative; margin: auto; background-size: 100% 100%;
        min-height: 150px; max-height: 100%; cursor: pointer; touch-action: none;
        background-image: url(data:@file/png;base64,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);
      }
      .sc-shutter-selector-slide {
        position: absolute; top: ${SLIDER_MIN_PX}px; left: 6%; width: 88%; height: 0;
        background-image: url(data:@file/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAGCAYAAAACEPQxAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAIGNIUk0AAHpPAACA1wAA+5gAAH6BAAB41AAA6bgAADhTAAAa8BY+DIIAAAAoSURBVHjaYjh48OBqpt+/f3sx8fHxcTFJSkoyMHFycjIwcXJyHgYMAKRuB6wLmIXlAAAAAElFTkSuQmCC);
      }
      .sc-shutter-selector-picker {
        position: absolute; top: ${SLIDER_MIN_PX}px; left: 6%; width: 88%;
        cursor: pointer; height: 20px; background-repeat: no-repeat;
        touch-action: none;
        background-image: url(data:@file/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIkAAAAHCAYAAAA8nm5hAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAIGNIUk0AAHpPAACA1wAA+5gAAH6BAAB41AAA6bgAADhTAAAa8BY+DIIAAAG4SURBVHja7JYxstowEIZ/rWTJNuPODZyAjipFCq6Qw+RyHILuVXTMQGMzYxwDwpawrVT2MEkeL34UITP+GzXaWUnfr91lm83m+2w2+6qUgnMOQ9W2LYioX0e9rpxzYIzBOQfn3ENeRITD4aCLongTxpgvVVV9q+t6kEkYYwAAzjk8z0NVVf1BRr2eOl5dMTDGPNxLRDDG/DDGKKG1llpr2blqCGTOOeI4BuccdV3jer2ONF64ioRhiCiKYK1FVVWw1vbm+RPbsiyDsiylUEq1vu9jqEkYY7jdbrhcLphMJmCMQSn1btJR/17WWmit++ovhHiXNxFBStlIKVsRBAEFQQDO+aCEnHPsdjusVissFgvM53P4vj+SeFEREdbrNbbbLZbLJabTKdq2fbjfGMOttSTyPLee5xnOeT/Y/G0l2e/3iKIIYRgiy7J+ILrvgaOeaxG/zhSfiWeMoa5rZFmGOI4BAGmaPuwaRISiKMrT6WRFkiRra63oTDLEmWmaAgDyPMfxePztUv/DEHv/+B9BeRbaMyYZkvc+rvv4TdMgz3PEcYwkSdA0zYd8z+ez1lq//QQAAP//AwAV5u5HIxEL5wAAAABJRU5ErkJggg==);
      }
      .sc-shutter-selector-picker:focus-visible {
        outline: 2px solid var(--primary-color, #03a9f4);
        outline-offset: 2px;
      }
      .sc-shutter-movement-overlay {
        position: absolute; top: ${SLIDER_MIN_PX}px; left: 6%; width: 88%; height: ${SLIDER_RANGE_PX}px;
        background-color: rgba(0,0,0,0.3); text-align: center; --mdc-icon-size: 60px;
        display: none; pointer-events: none;
      }
      .sc-shutter-movement-open { display: none; }
      .sc-shutter-movement-close { display: none; }
      .sc-shutter-top { text-align: center; margin-bottom: 1rem; }
      .sc-shutter-bottom { text-align: center; margin-top: 1rem; }
      .sc-shutter-label {
        display: inline-block; font-size: 20px; vertical-align: middle; cursor: pointer;
        color: var(--primary-text-color);
      }
      .sc-shutter-position {
        display: inline-block; vertical-align: middle; padding: 0 6px; margin-left: 1rem;
        border-radius: 2px; background-color: var(--secondary-background-color);
        color: var(--primary-text-color);
      }
      .sc-shutter-floating-position {
        display: none; position: absolute; width: 4ex;
        margin-left: auto; margin-right: auto; left: 0; right: 0; bottom: 0;
        border-radius: 2px; background-color: var(--secondary-background-color);
        color: var(--primary-text-color); text-align: center; font-size: 12px;
        pointer-events: none;
      }
    `;

    card.appendChild(allShutters);
    this.appendChild(style);
  }

  _callService(hass, service, entityId, args = {}) {
    hass.callService('cover', service, {
      entity_id: entityId,
      ...args,
    });
  }

  _updateButtonStates(shutter, percent, inverted) {
    if (typeof percent !== 'number') return;

    const upDisabled = percent === 0 ? inverted : percent === 100 ? !inverted : false;
    const downDisabled = percent === 0 ? !inverted : percent === 100 ? inverted : false;

    shutter.querySelectorAll('.sc-shutter-button-up').forEach((btn) => {
      btn.disabled = upDisabled;
    });
    shutter.querySelectorAll('.sc-shutter-button-down').forEach((btn) => {
      btn.disabled = downDisabled;
    });
  }

  _positionPercentToText(percent, inverted, alwaysPercentage, hass) {
    if (!alwaysPercentage) {
      if (percent === 100) {
        return hass.localize(inverted ? 'ui.components.logbook.messages.was_closed' : 'ui.components.logbook.messages.was_opened') || (inverted ? 'Closed' : 'Opened');
      }
      if (percent === 0) {
        return hass.localize(inverted ? 'ui.components.logbook.messages.was_opened' : 'ui.components.logbook.messages.was_closed') || (inverted ? 'Opened' : 'Closed');
      }
    }
    return percent + ' %';
  }

  _setPickerPosition(position, picker, slide) {
    const clamped = clampPosition(position);
    picker.style.top = clamped + 'px';
    slide.style.height = (clamped - SLIDER_MIN_PX) + 'px';
  }

  _setMovement(movement, shutter) {
    const overlay = shutter.querySelector('.sc-shutter-movement-overlay');
    if (!overlay) return;

    if (movement === 'opening' || movement === 'closing') {
      const opening = movement === 'opening';
      overlay.style.display = 'block';
      const openIcon = shutter.querySelector('.sc-shutter-movement-open');
      const closeIcon = shutter.querySelector('.sc-shutter-movement-close');
      if (openIcon) openIcon.style.display = opening ? 'block' : 'none';
      if (closeIcon) closeIcon.style.display = opening ? 'none' : 'block';
    } else {
      overlay.style.display = 'none';
    }
  }

  setConfig(config) {
    if (!config.entities || !Array.isArray(config.entities)) {
      throw new Error('You need to define entities');
    }

    this.config = config;
    this._entities = config.entities.map(normalizeEntityConfig);
    this.isUpdating = false;
  }

  static getStubConfig() {
    return { entities: [] };
  }

  getCardSize() {
    return this.config.entities.length + 1;
  }
}

customElements.define('shutter-card', ShutterCard);
