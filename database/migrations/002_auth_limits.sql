CREATE TABLE rate_limit_buckets (key text PRIMARY KEY,window_start timestamptz NOT NULL,hits integer NOT NULL CHECK(hits>0));
CREATE INDEX rate_limit_cleanup ON rate_limit_buckets(window_start);
