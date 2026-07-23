const TESTIMONIALS = [
  {
    quote:
      "Best visa assistance services in Delhi. Strict commitment, prompt response, swift process and real follow-up.",
    author: "Harish C",
  },
  {
    quote:
      "Super service. I am a regular customer since 2015 and got so many visa approvals. 100% recommended.",
    author: "Srinivasa Raju",
  },
  {
    quote:
      "A very quick, reliable and prompt service provider. Good experience across all types of visas.",
    author: "Jenny Natarajan",
  },
  {
    quote:
      "From day one, they receive documents with the same care as the first day. Upright and honest about what they can do.",
    author: "Ease Travels",
  },
];

export function Testimonials() {
  return (
    <section className="bg-ink text-white">
      <div className="mx-auto max-w-6xl px-4 py-16 md:py-20">
        <p className="mrz text-xs text-rgs-red mb-2">Clients since 2011</p>
        <h2 className="text-3xl md:text-4xl font-bold mb-10 text-white">
          The reviews came before the website
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {TESTIMONIALS.map((testimonial) => (
            <figure
              key={testimonial.author}
              className="rounded-2xl bg-white/5 border border-white/10 p-5"
            >
              <blockquote className="text-sm leading-relaxed text-white/85">
                &ldquo;{testimonial.quote}&rdquo;
              </blockquote>
              <figcaption className="mrz mt-4 text-xs text-rgs-red">
                {testimonial.author}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
