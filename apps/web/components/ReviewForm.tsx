"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError } from "@/lib/api-client";

/**
 * Verified-purchase review. The API accepts one review per order line and only
 * for a customer session (`POST /api/v1/reviews`), so the form is offered per
 * delivered line on the order page and disappears once it succeeds.
 */
export function ReviewForm({ orderLineId, productName }: { orderLineId: number; productName: string }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState("");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const { toast } = useToast();

  if (done) {
    return <span className="badge ok">Review submitted</span>;
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--outline btn--sm" onClick={() => setOpen(true)}>
        Write a review
      </button>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/reviews", {
        method: "POST",
        body: {
          order_line_id: orderLineId,
          rating,
          title: title.trim() || undefined,
          comment: comment.trim() || undefined,
        },
      });
      setDone(true);
      setOpen(false);
      toast({
        title: "Thanks for the review",
        description: "It appears on the product page once the store publishes it.",
      });
    } catch (caught) {
      toast({
        title: "Could not submit the review",
        description: caught instanceof ApiError ? caught.message : "Try again",
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel" style={{ marginTop: "0.6rem" }}>
      <h4 style={{ fontSize: "0.9rem" }}>Review {productName}</h4>
      <div className="field">
        <label htmlFor={`rating-${orderLineId}`}>Rating</label>
        <select id={`rating-${orderLineId}`} value={rating} onChange={(event) => setRating(Number(event.target.value))}>
          {[5, 4, 3, 2, 1].map((value) => (
            <option key={value} value={value}>
              {"★".repeat(value)} — {value} of 5
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`title-${orderLineId}`}>Headline (optional)</label>
        <input
          id={`title-${orderLineId}`}
          maxLength={120}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`comment-${orderLineId}`}>Comment (optional)</label>
        <textarea
          id={`comment-${orderLineId}`}
          rows={3}
          maxLength={2000}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </div>
      <div className="toolbar" style={{ margin: 0 }}>
        <button type="submit" className="btn btn--sm" disabled={saving}>
          {saving ? "Submitting…" : "Submit review"}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
