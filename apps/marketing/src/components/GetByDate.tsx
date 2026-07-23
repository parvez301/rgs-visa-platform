"use client";

import { useEffect, useState } from "react";

export function GetByDate({ processingDays }: { processingDays: number }) {
  const [formattedDate, setFormattedDate] = useState<string | null>(null);

  useEffect(() => {
    const deliveryDate = new Date();
    deliveryDate.setDate(deliveryDate.getDate() + processingDays);
    setFormattedDate(
      deliveryDate.toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
    );
  }, [processingDays]);

  if (!formattedDate) {
    return <span>{processingDays} working days</span>;
  }
  return <span>Get it by {formattedDate}</span>;
}
