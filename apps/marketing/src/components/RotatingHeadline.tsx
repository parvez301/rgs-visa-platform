"use client";

import { useEffect, useState } from "react";

/** Captions carried over from the original raysglobalservices.com hero slider. */
const HEADLINE_SLIDES: Array<{ before: string; accent: string; after: string }> = [
  { before: "Visas for Indians,\ndone ", accent: "properly", after: "." },
  { before: "", accent: "Hassle-free", after: " visas,\ntravel & study abroad." },
  { before: "Travel made ", accent: "simple", after: ",\nworry-free, on time." },
  { before: "Visas & admissions,\n", accent: "tailored for you", after: "." },
];

const ROTATION_INTERVAL_MS = 3000;

export function RotatingHeadline() {
  const [slideIndex, setSlideIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (isPaused) return;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) return;
    const rotationTimer = setInterval(
      () => setSlideIndex((currentIndex) => (currentIndex + 1) % HEADLINE_SLIDES.length),
      ROTATION_INTERVAL_MS,
    );
    return () => clearInterval(rotationTimer);
  }, [isPaused]);

  const activeSlide = HEADLINE_SLIDES[slideIndex]!;

  return (
    <div
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <h1
        key={slideIndex}
        className="text-4xl md:text-6xl font-bold leading-[1.05] whitespace-pre-line min-h-[2.1em] animate-[headline-fade_0.6s_ease-out]"
      >
        {activeSlide.before}
        <span className="text-rgs-red">{activeSlide.accent}</span>
        {activeSlide.after}
      </h1>
      <div className="mt-5 flex gap-2" role="tablist" aria-label="Headline slides">
        {HEADLINE_SLIDES.map((_slide, indicatorIndex) => (
          <button
            key={indicatorIndex}
            role="tab"
            aria-selected={indicatorIndex === slideIndex}
            aria-label={`Slide ${indicatorIndex + 1}`}
            onClick={() => setSlideIndex(indicatorIndex)}
            className={`h-1.5 rounded-full transition-all ${
              indicatorIndex === slideIndex
                ? "w-8 bg-rgs-red"
                : "w-3 bg-line hover:bg-ink-soft/40"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
