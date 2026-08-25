ALTER TABLE monitor_incident
  ADD COLUMN resolution_reason TEXT CHECK (
    resolution_reason IS NULL OR resolution_reason IN (
      'catalog-removed',
      'policy-excluded',
      'recovered'
    )
  );

UPDATE monitor_incident
SET resolution_reason = 'recovered'
WHERE status = 'resolved';
