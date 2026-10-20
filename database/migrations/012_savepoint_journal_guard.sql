-- xmin is a subtransaction ID inside a SAVEPOINT; pg_current_xact_id() is the
-- top-level ID. Equality rejects valid offline atomic posting. An uncommitted
-- journal visible to this connection can only belong to this transaction: other
-- transactions' uncommitted tuples are not visible under PostgreSQL MVCC.
CREATE OR REPLACE FUNCTION protect_journal_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE raw_xmin bigint; top_id numeric; insert_id numeric; state text;
BEGIN
 SELECT xmin::text::bigint INTO raw_xmin FROM journals WHERE id=NEW.journal_id AND company_id=NEW.company_id;
 IF raw_xmin IS NULL THEN RAISE EXCEPTION 'cannot append to a posted journal' USING ERRCODE='23514'; END IF;
 top_id:=pg_current_xact_id()::text::numeric;
 -- Lift the 32-bit tuple xmin into the current full-transaction epoch, including
 -- an own subtransaction which crossed a 32-bit wrap boundary.
 insert_id:=top_id-mod(top_id,4294967296)+raw_xmin;
 IF insert_id<top_id THEN insert_id:=insert_id+4294967296; END IF;
 BEGIN
  state:=pg_xact_status(insert_id::text::xid8);
 EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'cannot append to a posted journal' USING ERRCODE='23514';
 END;
 IF state IS DISTINCT FROM 'in progress' THEN
  RAISE EXCEPTION 'cannot append to a posted journal' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
