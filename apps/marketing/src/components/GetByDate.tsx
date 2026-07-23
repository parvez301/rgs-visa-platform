"use client";

import { useEffect, useState } from "react";

function addWorkingDays(startDate: Date, workingDays: number): Date {
  const resultDate = new Date(startDate);
  let remainingDays = workingDays;
  while (remainingDays > 0) {
    resultDate.setDate(resultDate.getDate() + 1);
    const dayOfWeek = resultDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      remainingDays -= 1;
    }
  }
  return resultDate;
}

export function GetByDate({ processingDays }: { processingDays: number }) {
  const [formattedDate, setFormattedDate] = useState<string | null>(null);

  useEffect(() => {
    const deliveryDate = addWorkingDays(new Date(), processingDays);
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
