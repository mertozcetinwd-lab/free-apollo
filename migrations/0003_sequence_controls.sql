-- Sequence planning settings. This migration adds no sending capability.
ALTER TABLE prospect_sequences ADD COLUMN schedule TEXT NOT NULL DEFAULT '{"days":[1,2,3,4,5],"start":"08:00","end":"17:00","timezone":"local"}';
ALTER TABLE prospect_sequences ADD COLUMN rules TEXT NOT NULL DEFAULT '{"stop_on_reply":true,"stop_on_meeting":true,"pause_on_ooo":true,"bounce_guard":true,"daily_cap":50}';
