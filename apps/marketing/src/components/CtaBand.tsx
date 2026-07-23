import { applyUrl } from "@/lib/site";

export function CtaBand() {
  return (
    <section className="bg-rgs-red">
      <div className="mx-auto max-w-6xl px-4 py-14 md:py-16 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div>
          <h2 className="text-3xl md:text-4xl font-bold text-white">
            Ready to travel?
          </h2>
          <p className="mt-2 text-white/85 max-w-xl">
            Start your application now — it takes about 10 minutes, and you only
            pay after our team reviews your file.
          </p>
        </div>
        <a
          href={applyUrl()}
          className="rounded-full bg-white px-8 py-4 font-semibold text-rgs-red hover:bg-ink hover:text-white transition-colors shrink-0"
        >
          Start your application
        </a>
      </div>
    </section>
  );
}
