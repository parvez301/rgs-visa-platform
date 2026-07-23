import { useEffect, useState } from "react";

const HERO_SLIDES = [
  {
    photo: "/countries/ae.jpg",
    caption: "Every application, one queue.",
    subCaption: "Review documents, request payment, move cases to decision.",
  },
  {
    photo: "/countries/ca.jpg",
    caption: "See what travellers are doing, live.",
    subCaption: "Signups, uploads and submissions — as they happen.",
  },
  {
    photo: "/countries/zm.jpg",
    caption: "Fees, docs, timelines — yours to edit.",
    subCaption: "Config changes go live for new applications instantly.",
  },
];

const ROTATION_INTERVAL_MS = 4500;

export function AuthHero() {
  const [slideIndex, setSlideIndex] = useState(0);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) return;
    const rotationTimer = setInterval(
      () => setSlideIndex((currentIndex) => (currentIndex + 1) % HERO_SLIDES.length),
      ROTATION_INTERVAL_MS,
    );
    return () => clearInterval(rotationTimer);
  }, []);

  return (
    <div className="relative hidden lg:block overflow-hidden" aria-hidden="true">
      {HERO_SLIDES.map((heroSlide, heroSlideIndex) => (
        <div
          key={heroSlide.photo}
          className="absolute inset-0 bg-cover bg-center transition-opacity duration-700"
          style={{
            backgroundImage: `url(${heroSlide.photo})`,
            opacity: heroSlideIndex === slideIndex ? 1 : 0,
          }}
        />
      ))}
      <div className="absolute inset-0 bg-gradient-to-t from-ink/90 via-ink/40 to-ink/30" />
      <div className="absolute bottom-0 left-0 right-0 p-12">
        <div key={slideIndex} className="max-w-xl">
          <p className="font-display text-4xl font-bold leading-tight text-white">
            {HERO_SLIDES[slideIndex]!.caption}
          </p>
          <p className="mt-3 text-lg text-white/80">{HERO_SLIDES[slideIndex]!.subCaption}</p>
        </div>
        <div className="mt-6 flex gap-2">
          {HERO_SLIDES.map((_heroSlide, indicatorIndex) => (
            <button
              key={indicatorIndex}
              onClick={() => setSlideIndex(indicatorIndex)}
              aria-label={`Slide ${indicatorIndex + 1}`}
              className={`h-1.5 rounded-full transition-all ${
                indicatorIndex === slideIndex ? "w-8 bg-rgs-red" : "w-3 bg-white/40"
              }`}
            />
          ))}
        </div>
        <p className="mrz mt-8 text-[10px] text-white/40">RGS Admin · Operations console</p>
      </div>
    </div>
  );
}
