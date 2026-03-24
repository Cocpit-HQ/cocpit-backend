ALTER TABLE tickets
ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP;

ALTER TABLE tickets
ALTER COLUMN status SET DEFAULT 'valid';

UPDATE tickets
SET status = 'valid'
WHERE status IS NULL OR LOWER(status) = 'active';
