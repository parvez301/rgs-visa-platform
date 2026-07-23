const PROCESS_STEPS = [
  {
    title: "Apply online",
    detail:
      "Pick your destination, add travellers, and upload documents from your phone. Takes about 10 minutes.",
  },
  {
    title: "We verify your documents",
    detail:
      "Our visa team checks every page against government guidelines before anything is submitted — this is where most rejections are prevented.",
  },
  {
    title: "Submitted to immigration",
    detail:
      "We lodge your application with the embassy or e-visa portal and follow up until there's a decision.",
  },
  {
    title: "Visa delivered",
    detail:
      "Your approved visa lands in your inbox and portal dashboard, ready to download and print.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="bg-mist border-y border-line">
      <div className="mx-auto max-w-6xl px-4 py-16 md:py-20">
        <p className="mrz text-xs text-rgs-red mb-2">The process</p>
        <h2 className="text-3xl md:text-4xl font-bold mb-10">
          Four steps. You do one of them.
        </h2>
        <ol className="grid md:grid-cols-4 gap-6">
          {PROCESS_STEPS.map((processStep, stepIndex) => (
            <li
              key={processStep.title}
              className="relative rounded-2xl bg-paper border border-line p-6"
            >
              <p className="mrz text-xs text-rgs-red mb-3">
                Step {stepIndex + 1} of {PROCESS_STEPS.length}
              </p>
              <h3 className="font-bold text-lg mb-2">{processStep.title}</h3>
              <p className="text-sm text-ink-soft leading-relaxed">{processStep.detail}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
