export interface TriggerContract {
  name: string;
  table: string;
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  timing: 'BEFORE' | 'AFTER';
  orientation: 'ROW';
  statement: string;
}

const INSERT_STATEMENT = `BEGIN
  IF NEW.status IS NULL THEN
    IF NEW.stock IS NULL THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Product stock is required during status migration';
    ELSEIF NEW.stock = 0 THEN
      SET NEW.status = 'sold', NEW.stock = 0;
    ELSE
      SET NEW.status = 'available', NEW.stock = 1;
    END IF;
  ELSEIF NOT (
    (BINARY NEW.status = 'available' AND NEW.stock = 1)
    OR (BINARY NEW.status = 'sold' AND NEW.stock = 0)
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Product status and stock are inconsistent';
  END IF;
END`;

const UPDATE_STATEMENT = `BEGIN
  IF NEW.status IS NULL OR NEW.stock IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Product status and stock are required';
  ELSEIF OLD.status IS NULL THEN
    IF NOT (
      (BINARY NEW.status = 'available' AND NEW.stock = 1)
      OR (BINARY NEW.status = 'sold' AND NEW.stock = 0)
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Product backfill status and stock are inconsistent';
    END IF;
  ELSEIF BINARY OLD.status = 'sold' AND BINARY NEW.status = 'available' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A sold product cannot become available';
  ELSEIF NEW.status <=> OLD.status AND NOT (NEW.stock <=> OLD.stock) THEN
    IF BINARY OLD.status = 'available' THEN
      IF NEW.stock = 0 THEN
        SET NEW.status = 'sold', NEW.stock = 0;
      ELSE
        SET NEW.status = 'available', NEW.stock = 1;
      END IF;
    ELSEIF NEW.stock <> 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'A sold product cannot regain stock';
    ELSE
      SET NEW.status = 'sold', NEW.stock = 0;
    END IF;
  ELSEIF NOT (
    (BINARY NEW.status = 'available' AND NEW.stock = 1)
    OR (BINARY NEW.status = 'sold' AND NEW.stock = 0)
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Product status and stock are inconsistent';
  END IF;
END`;

const DELETE_STATEMENT = `BEGIN
  IF OLD.listing_request_id IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Listed products must be soft deleted';
  END IF;
END`;

export const PRODUCT_STATUS_TRIGGER_CONTRACTS = [
  {
    name: 'products_status_compatibility_before_insert',
    table: 'products',
    event: 'INSERT',
    timing: 'BEFORE',
    orientation: 'ROW',
    statement: INSERT_STATEMENT,
  },
  {
    name: 'products_status_compatibility_before_update',
    table: 'products',
    event: 'UPDATE',
    timing: 'BEFORE',
    orientation: 'ROW',
    statement: UPDATE_STATEMENT,
  },
  {
    name: 'products_listing_tombstone_before_delete',
    table: 'products',
    event: 'DELETE',
    timing: 'BEFORE',
    orientation: 'ROW',
    statement: DELETE_STATEMENT,
  },
] as const satisfies readonly TriggerContract[];

/** MySQL adds quoting and character-set introducers to trigger metadata. */
export function normalizeTriggerStatement(value: string): string {
  let normalized = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quoted) {
      normalized += character;
      if (character === '\\' && index + 1 < value.length) {
        // Preserve both the escape and its escaped byte exactly.
        normalized += value[(index += 1)]!;
      } else if (character === "'") {
        if (value[index + 1] === "'") {
          // SQL escapes a quote by doubling it; keep the pair in the literal.
          normalized += value[(index += 1)]!;
        } else {
          quoted = false;
        }
      }
      continue;
    }

    if (character === "'") {
      quoted = true;
      normalized += character;
      continue;
    }
    if (/\s/u.test(character) || character === '`') continue;
    if (character === '_') {
      const introducer = /^_[a-z0-9]+(?=')/i.exec(value.slice(index));
      if (introducer) {
        index += introducer[0].length - 1;
        continue;
      }
    }
    normalized += character.toLowerCase();
  }
  return normalized.replace(/;+$/u, '');
}
