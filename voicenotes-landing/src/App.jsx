import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ArrowRight, Hexagon, FileText, Users, Menu, X, Layers } from 'lucide-react';

gsap.registerPlugin(ScrollTrigger);

// --- Navbar ---
const Navbar = () => {
  const navRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const ctx = gsap.context(() => {
      ScrollTrigger.create({
        start: 'top -50',
        end: 99999,
        toggleClass: {
          className: 'bg-primary/60 backdrop-blur-xl border border-white/10 shadow-lg',
          targets: navRef.current
        }
      });
    }, navRef);
    return () => ctx.revert();
  }, []);

  return (
    <nav
      ref={navRef}
      className="fixed top-6 left-1/2 -translate-x-1/2 z-50 w-[90%] max-w-5xl rounded-full transition-all duration-300 px-6 py-4 flex items-center justify-between"
    >
      <div className="font-heading font-bold text-xl tracking-tight flex items-center gap-2">
        <Hexagon className="w-6 h-6 text-accent" />
        VoiceNotez
      </div>

      <div className="hidden md:flex items-center gap-8 font-data text-sm text-gray-400">
        <a href="#features" className="hover:text-white transition-colors">Features</a>
        <a href="#how-it-works" className="hover:text-white transition-colors">How It Works</a>
        <a href="#privacy" className="hover:text-white transition-colors">Privacy</a>
      </div>

      <div className="hidden md:flex items-center">
        <a href="/register" className="btn-magnetic px-6 py-2 rounded-3xl bg-accent text-white font-heading font-semibold text-sm hover:bg-accent/90 no-underline">
          <span className="sliding-bg"></span>
          <span className="relative z-10 flex items-center gap-2">
            Get Started <ArrowRight className="w-4 h-4" />
          </span>
        </a>
      </div>

      <button className="md:hidden text-white" onClick={() => setIsOpen(!isOpen)}>
        {isOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-4 w-full bg-primary/95 backdrop-blur-xl border border-white/10 rounded-2xl p-6 flex flex-col gap-6 md:hidden">
          <a href="#features" onClick={() => setIsOpen(false)} className="font-data text-sm">Features</a>
          <a href="#how-it-works" onClick={() => setIsOpen(false)} className="font-data text-sm">How It Works</a>
          <a href="#privacy" onClick={() => setIsOpen(false)} className="font-data text-sm">Privacy</a>
          <a href="/register" className="block w-full py-3 rounded-xl bg-accent text-white font-heading font-semibold text-sm text-center no-underline">
            Get Started
          </a>
        </div>
      )}
    </nav>
  );
};

// --- Hero Section ---
const Hero = () => {
  const containerRef = useRef(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.from('.hero-element', {
        y: 40,
        opacity: 0,
        duration: 1.2,
        stagger: 0.08,
        ease: 'power3.out',
        delay: 0.2
      });
    }, containerRef);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={containerRef} className="relative h-[100dvh] w-full overflow-hidden flex items-end pb-24 md:pb-32 px-6 md:px-12 lg:px-24">
      <div className="absolute inset-0 z-0">
        <img
          src="https://images.unsplash.com/photo-1550751827-4bd374c3f58b?auto=format&fit=crop&q=80"
          alt="background"
          className="w-full h-full object-cover opacity-60 mix-blend-screen"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-primary via-primary/80 to-transparent"></div>
      </div>

      <div className="relative z-10 max-w-4xl">
        <div className="flex flex-col gap-2 mb-8">
          <h1 className="hero-element font-heading font-bold text-4xl md:text-6xl lg:text-7xl leading-[1.1] tracking-tight">
            Meeting notes that
          </h1>
          <h2 className="hero-element font-drama italic text-5xl md:text-7xl lg:text-8xl text-accent/90 leading-[1] mt-2">
            actually work.
          </h2>
        </div>

        <p className="hero-element font-data text-gray-400 max-w-xl text-sm md:text-base leading-relaxed mb-10">
          Built for the meetings tech teams are already in — sprint plans, feature kickoffs, stakeholder calls. Record, transcribe, and get a structured summary with action items pulled out automatically. No OpenAI. No Anthropic. Just your notes.
        </p>

        <div className="hero-element flex flex-wrap gap-4">
          <a href="/register" className="btn-magnetic bg-accent text-white px-8 py-4 rounded-full font-heading font-bold text-sm md:text-base flex items-center gap-2 h-14 no-underline">
            <span className="sliding-bg"></span>
            <span className="relative z-10 flex items-center gap-2">
              Create an Account <ArrowRight className="w-4 h-4" />
            </span>
          </a>
          <a href="/login" className="btn-magnetic bg-white/5 border border-white/10 backdrop-blur-md text-white px-8 py-4 rounded-full font-heading font-bold text-sm md:text-base h-14 hover:bg-white/10 no-underline">
            <span className="relative z-10">Login</span>
          </a>
        </div>
      </div>
    </section>
  );
};

// --- Features Section ---

// Card 1: Meeting Type Shuffler
const MeetingTypeShuffler = () => {
  const [cards, setCards] = useState([
    { id: 1, icon: '🗂️', title: 'Sprint Planning', desc: 'Extracts stories, blockers, capacity, and carryover — ready to drop into your tracker.' },
    { id: 2, icon: '🚀', title: 'Feature Kickoff', desc: 'Captures technical decisions, scope concerns, open questions, and timeline commitments.' },
    { id: 3, icon: '☕', title: 'Manager 1:1', desc: 'Catches every directive and piece of feedback, even the casual mentions.' },
    { id: 4, icon: '✏️', title: 'Customize Your Own', desc: 'Write your own prompt for any meeting type. Full control over what gets pulled out.' },
  ]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCards(prev => {
        const newCards = [...prev];
        const last = newCards.pop();
        newCards.unshift(last);
        return newCards;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-[#12121A] border border-white/10 rounded-[2rem] p-8 h-[380px] relative overflow-hidden flex flex-col group hover:-translate-y-1 transition-transform duration-500">
      <div className="flex items-center gap-3 mb-8 text-accent font-data text-xs uppercase tracking-widest">
        <Layers className="w-4 h-4" /> Meeting Types
      </div>

      <div className="relative flex-1">
        {cards.map((card, index) => {
          const isTop = index === 0;
          return (
            <div
              key={card.id}
              className={`absolute top-0 left-0 w-full bg-white/5 border border-white/10 p-6 rounded-2xl backdrop-blur-sm transition-all duration-700 ease-[cubic-bezier(0.34,1.56,0.64,1)]
                ${isTop ? 'translate-y-0 opacity-100 scale-100 z-30 shadow-2xl shadow-black/50' :
                  index === 1 ? 'translate-y-10 opacity-30 scale-95 z-20' :
                    'translate-y-16 opacity-10 scale-90 z-10'}`}
            >
              <div className="text-xl mb-2">{card.icon}</div>
              <h3 className="font-heading font-bold text-lg mb-2">{card.title}</h3>
              <p className="font-data text-sm text-gray-400">{card.desc}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Card 2: Summary Typewriter
const SummaryTypewriter = () => {
  const [text, setText] = useState('');
  const fullText = `// Sprint Planning — May 14

Action Items:
→ [Sarah] Fix auth bug — EOD Fri — P1
→ [Dev] Spike on rate limiting — next sprint
→ [PM] Update Jira with final point estimates

Blockers:
→ API integration blocked on design sign-off

Decisions:
→ Defer mobile push to Q3
→ Go with Option B for the DB schema`;

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      setText(fullText.slice(0, i));
      i++;
      if (i > fullText.length) i = 0;
    }, 40);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-[#12121A] border border-white/10 rounded-[2rem] p-8 h-[380px] flex flex-col group hover:-translate-y-1 transition-transform duration-500">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3 font-data text-xs text-gray-400 uppercase tracking-widest">
          <FileText className="w-4 h-4" /> Structured Summary
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
          <span className="font-data text-[10px] text-gray-500">LIVE</span>
        </div>
      </div>

      <div className="bg-black/50 rounded-xl p-5 flex-1 font-data text-xs text-accent/80 whitespace-pre overflow-hidden relative border border-white/5 leading-relaxed">
        {text}
        <span className="inline-block w-2 bg-accent h-3 ml-1 animate-pulse align-middle"></span>
      </div>
    </div>
  );
};

// Card 3: Privacy — not sent to Big Tech
const PrivacyCard = () => {
  const companies = ['OpenAI', 'Anthropic', 'Google AI', 'Microsoft'];
  const [strikeIndex, setStrikeIndex] = useState(-1);

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      setStrikeIndex(i);
      i++;
      if (i >= companies.length) {
        setTimeout(() => setStrikeIndex(-1), 1800);
        i = 0;
      }
    }, 600);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-[#12121A] border border-white/10 rounded-[2rem] p-8 h-[380px] relative flex flex-col group hover:-translate-y-1 transition-transform duration-500">
      <div className="flex items-center gap-3 mb-8 font-data text-xs text-accent uppercase tracking-widest">
        <Users className="w-4 h-4" /> Private by Default
      </div>

      <div className="relative flex-1 flex flex-col justify-between">
        <p className="font-data text-sm text-gray-400 leading-relaxed mb-4">
          Your audio and transcripts never touch a third-party AI API. Transcription and summarization run on models we host ourselves — not rented from Big Tech.
        </p>

        <div className="space-y-3">
          <p className="font-data text-xs text-gray-600 uppercase tracking-widest mb-3">Not sent to:</p>
          {companies.map((company, i) => (
            <div key={company} className="flex items-center gap-3">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs transition-all duration-300 ${i <= strikeIndex ? 'bg-red-500/20 text-red-400' : 'bg-white/5 text-gray-600'}`}>
                {i <= strikeIndex ? '✕' : '○'}
              </div>
              <span className={`font-data text-sm transition-all duration-300 ${i <= strikeIndex ? 'text-gray-600 line-through' : 'text-gray-300'}`}>
                {company}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 pt-4 border-t border-white/5 font-data text-xs text-gray-500">
          Your data is stored in your account and never used for training.
        </div>
      </div>
    </div>
  );
};

const Features = () => {
  return (
    <section id="features" className="py-24 px-6 md:px-12 lg:px-24">
      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6">
        <MeetingTypeShuffler />
        <SummaryTypewriter />
        <PrivacyCard />
      </div>
    </section>
  );
};

// --- Philosophy Section ---
const Philosophy = () => {
  const philRef = useRef(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.from('.phil-word', {
        scrollTrigger: {
          trigger: philRef.current,
          start: 'top 60%',
        },
        y: 50,
        opacity: 0,
        duration: 1,
        stagger: 0.07,
        ease: 'power3.out'
      });
    }, philRef);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={philRef} id="privacy" className="relative py-40 overflow-hidden bg-black/50">
      <div className="absolute inset-0 z-0">
        <img
          src="https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80"
          alt="abstract background"
          className="w-full h-full object-cover opacity-10 mix-blend-screen"
        />
      </div>
      <div className="relative z-10 max-w-5xl mx-auto px-6 md:px-12 text-center">
        <p className="font-heading text-lg md:text-2xl text-gray-500 mb-12 uppercase tracking-widest font-bold">
          <span className="phil-word inline-block mr-2">Most</span>
          <span className="phil-word inline-block mr-2">apps</span>
          <span className="phil-word inline-block mr-2">send</span>
          <span className="phil-word inline-block mr-2">your</span>
          <span className="phil-word inline-block mr-2">words</span>
          <span className="phil-word inline-block mr-2">straight</span>
          <span className="phil-word inline-block mr-2">to</span>
          <span className="phil-word inline-block text-white">OpenAI.</span>
        </p>
        <p className="font-drama italic text-5xl md:text-7xl lg:text-[7rem] leading-none text-white">
          <span className="phil-word inline-block mr-4">We</span>
          <span className="phil-word inline-block mr-4">built</span>
          <br />
          <span className="phil-word inline-block text-accent">our own.</span>
        </p>
      </div>
    </section>
  );
};

// --- How It Works Section ---
const HowItWorks = () => {
  const containerRef = useRef(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      const cards = gsap.utils.toArray('.protocol-card');

      cards.forEach((card, i) => {
        if (i === cards.length - 1) return;

        ScrollTrigger.create({
          trigger: card,
          start: 'top top+=100',
          endTrigger: containerRef.current,
          end: 'bottom bottom',
          pin: true,
          pinSpacing: false,
          animation: gsap.to(card, {
            scale: 0.9,
            opacity: 0.5,
            filter: 'blur(10px)',
            ease: 'none'
          }),
          scrub: true
        });
      });
    }, containerRef);
    return () => ctx.revert();
  }, []);

  const steps = [
    {
      num: '01',
      title: 'Hit record.',
      desc: 'Open the app at the start of any meeting and press record. Audio is transcribed in real time using a Whisper model we host ourselves — you get a live transcript as the meeting happens.',
      anim: (
        <svg className="w-full h-full text-white/20 animate-spin-slow" viewBox="0 0 100 100" fill="none">
          <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" />
          <circle cx="50" cy="50" r="25" stroke="#7B61FF" strokeWidth="2" strokeDasharray="10 10" />
        </svg>
      )
    },
    {
      num: '02',
      title: 'Pick a meeting type.',
      desc: 'Choose from built-in types like sprint planning, feature kickoff, stakeholder review, or 1:1 — or build your own with a custom prompt. Each type is tuned to pull out what actually matters for that kind of meeting.',
      anim: (
        <div className="w-full h-full relative overflow-hidden flex flex-col gap-3 p-4 justify-center">
          {['Sprint Planning', 'Feature Kickoff', 'Manager 1:1'].map((label, i) => (
            <div
              key={i}
              className={`px-4 py-2 rounded-lg border font-data text-sm transition-all ${i === 0 ? 'border-accent text-accent bg-accent/10' : 'border-white/10 text-gray-500'}`}
            >
              {label}
            </div>
          ))}
        </div>
      )
    },
    {
      num: '03',
      title: 'Get your summary.',
      desc: 'An LLM we host ourselves reads the transcript and outputs a structured breakdown: action items with owners and deadlines, decisions made, key discussion points, and follow-ups. You can also chat with the meeting after the fact.',
      anim: (
        <svg className="w-full h-full stroke-accent drop-shadow-[0_0_10px_rgba(123,97,255,0.8)]" viewBox="0 0 100 50" fill="none">
          <path d="M0,25 L20,25 L25,10 L35,40 L40,25 L60,25 L65,15 L75,35 L80,25 L100,25" strokeWidth="2">
            <animate attributeName="stroke-dasharray" values="0,200; 200,0" dur="2s" repeatCount="indefinite" />
          </path>
        </svg>
      )
    }
  ];

  return (
    <section id="how-it-works" ref={containerRef} className="py-24 px-6 md:px-12 relative">
      <div className="max-w-4xl mx-auto">
        <h2 className="font-heading font-bold text-3xl md:text-5xl mb-16 uppercase tracking-tight">How It Works</h2>

        <div className="flex flex-col gap-8 md:gap-0">
          {steps.map((step, i) => (
            <div
              key={i}
              className="protocol-card min-h-[50vh] bg-[#12121A] border border-white/10 rounded-[3rem] p-8 md:p-16 flex flex-col md:flex-row items-center gap-12 shadow-2xl relative z-[var(--z)]"
              style={{ '--z': i }}
            >
              <div className="w-full md:w-1/2 flex flex-col items-start">
                <div className="font-data text-accent text-xl mb-4">{step.num}</div>
                <h3 className="font-heading font-bold text-3xl md:text-4xl mb-4">{step.title}</h3>
                <p className="font-data text-gray-400 text-sm md:text-base leading-relaxed max-w-sm">{step.desc}</p>
              </div>
              <div className="w-full md:w-1/2 aspect-square max-h-64 bg-black/40 rounded-3xl border border-white/5 p-8 flex items-center justify-center">
                {step.anim}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

// --- Footer ---
const Footer = () => {
  return (
    <footer className="mt-24 bg-[#05050A] rounded-t-[4rem] px-6 md:px-12 lg:px-24 pt-20 pb-12 border-t border-white/5">
      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12 mb-16">
        <div className="md:col-span-2">
          <div className="font-heading font-bold text-2xl tracking-tight flex items-center gap-2 mb-6">
            <Hexagon className="w-8 h-8 text-accent" />
            VoiceNotez
          </div>
          <p className="font-data text-sm text-gray-500 max-w-xs">
            Meeting intelligence for tech teams. Structured summaries, action items, and private AI — all in one place.
          </p>
        </div>

        <div>
          <h4 className="font-heading font-bold mb-6 text-white text-sm uppercase tracking-widest">Legal</h4>
          <ul className="flex flex-col gap-4 font-data text-sm text-gray-400">
            <li><a href="#" className="hover:text-accent transition-colors">Privacy Policy</a></li>
            <li><a href="#" className="hover:text-accent transition-colors">Terms of Service</a></li>
          </ul>
        </div>
      </div>

      <div className="max-w-6xl mx-auto pt-8 border-t border-white/10 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="font-data text-xs text-gray-600">
          © 2026 VoiceNotez.
        </div>
      </div>
    </footer>
  );
};

const App = () => {
  return (
    <div className="bg-primary min-h-screen text-background selection:bg-accent selection:text-white">
      <Navbar />
      <Hero />
      <Features />
      <Philosophy />
      <HowItWorks />

      {/* CTA Section */}
      <section className="py-32 px-6 flex justify-center">
        <div className="bg-gradient-to-b from-accent/20 to-transparent border border-accent/30 rounded-[3rem] w-full max-w-4xl p-12 md:p-24 text-center relative overflow-hidden">
          <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1550745165-9bc0b252726f?q=80&w=2000')] opacity-5 mix-blend-overlay"></div>
          <div className="relative z-10">
            <h2 className="font-heading font-bold text-4xl md:text-6xl mb-6">Start taking better notes.</h2>
            <p className="font-data text-gray-400 mb-10 max-w-lg mx-auto">
              Free to use. Sign up and start recording your next meeting.
            </p>
            <a href="/register" className="btn-magnetic bg-accent text-white px-10 py-5 rounded-full font-heading font-bold text-lg flex items-center justify-center gap-3 mx-auto w-full md:w-auto shadow-[0_0_30px_rgba(123,97,255,0.4)] no-underline">
              <span className="sliding-bg"></span>
              <span className="relative z-10 flex items-center gap-2">
                Create an Account <ArrowRight className="w-5 h-5" />
              </span>
            </a>
            <div className="mt-6 font-data text-sm text-gray-500">
              Already have an account?{' '}
              <a href="/login" className="text-accent hover:underline">Login</a>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
};

export default App;
