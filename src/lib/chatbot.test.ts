import { describe, it, expect, vi } from 'vitest';

vi.mock('../cache/redis', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelete: vi.fn().mockResolvedValue(undefined),
  rateLimitRedis: null,
  default: null,
}));
vi.mock('../database/schema', () => ({
  queryAll: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  runSQL: vi.fn().mockResolvedValue(undefined),
}));

const {
  findBestMatch, extractKeywords, getSuggestions, isFollowUp, isLang, normaliseText,
} = await import('./chatbot');

const { queryAll } = await import('../database/schema');

const settings = {
  confidenceThreshold: 0.38,
  fuzzyThreshold: 0.42,
  welcomeMessages: { en: 'Hi', am: 'ሰላም', om: 'Akkam' },
  fallbackMessages: { en: 'No answer', am: 'አልተገኘም', om: 'Hin argamne' },
  enabledLanguages: ['en', 'am', 'om'] as const,
  autoApproveContent: true,
  syncIntervalMinutes: 10,
  maxHistoryTurns: 12,
};

const entry = (overrides: Partial<Parameters<typeof findBestMatch>[3][number]> = {}) => ({
  id: 'kb-1',
  intentId: 'about',
  intentName: 'about',
  language: 'en' as const,
  question: 'What does Yemisrach Dimts do?',
  alternatives: ['Who are you'],
  keywords: ['ministry', 'media', 'organisation'],
  answer: 'We are a Christian media ministry.',
  priority: 10,
  sourceType: 'manual' as const,
  sourceUrl: null,
  ...overrides,
});

describe('chatbot matching engine', () => {
  it('normalises multilingual text for matching', () => {
    expect(normaliseText('  What’s YOUR phone number?!  ')).toContain('what');
    expect(normaliseText('እንዴት ናችሁ?')).toContain('እንዴት');
    expect(normaliseText('Akkam jirtan?')).toContain('akkam');
  });

  it('extracts meaningful keywords while dropping English stop words', () => {
    const keywords = extractKeywords('Where are your bookshops in Addis Ababa?', 'en');
    expect(keywords).toContain('bookshop');
    expect(keywords).not.toContain('your');
  });

  it('recognises follow-up questions in all three languages', () => {
    expect(isFollowUp('tell me more', 'en')).toBe(true);
    expect(isFollowUp('ተጨማሪ ንገረኝ', 'am')).toBe(true);
    expect(isFollowUp('dabalataa', 'om')).toBe(true);
    expect(isFollowUp('What does Yemisrach Dimts do?', 'en')).toBe(false);
  });

  it('matches an exact database question with high confidence', () => {
    const match = findBestMatch('What does Yemisrach Dimts do?', 'en', settings, [entry()]);
    expect(match?.entry.id).toBe('kb-1');
    expect(match!.confidence).toBeGreaterThan(0.5);
  });

  it('matches on keywords when the wording differs', () => {
    const match = findBestMatch('media ministry', 'en', settings, [entry()]);
    expect(match?.entry.answer).toBe('We are a Christian media ministry.');
  });

  it('matches programme questions across program/programme spellings', () => {
    const programmes = entry({
      id: 'kb-programs',
      question: 'What radio programmes do you have?',
      alternatives: ['list of shows', 'how do I get your program?'],
      keywords: ['programme', 'radio', 'schedule', 'show'],
      answer: 'Browse the Programmes page for the current list.',
    });

    const exact = findBestMatch('how do I get your program?', 'en', settings, [programmes]);
    const short = findBestMatch('your programs', 'en', settings, [programmes]);

    expect(exact?.entry.id).toBe('kb-programs');
    expect(short?.entry.id).toBe('kb-programs');
  });

  it('answers who is sagalee missirachoo in Oromo', () => {
    const about = entry({
      id: 'chat-kb-about-om',
      language: 'om',
      question: 'Sagaleen Missirachoo maalidha?',
      alternatives: ['who is sagalee missirachoo', 'sagalee missirachoo', 'sagalee misirachoo'],
      keywords: ['sagalee', 'missirachoo', 'dhaabbata', 'tajaajila', 'yaa', 'ergama'],
      answer: 'Tajaajila Sagalee Misirachoo (YDCS) ... 1960moota ... gaʼuu dha.',
    });

    const match = findBestMatch('who is sagalee missirachoo?', 'om', settings, [about]);
    expect(match?.entry.id).toBe('chat-kb-about-om');
    expect(String(match?.entry.answer)).toContain('1960moota');
  });

  it('uses the vetted Amharic about text', () => {
    const about = entry({
      id: 'chat-kb-about-am',
      language: 'am',
      question: 'የምሥራች ድምጽ ማን ነው?',
      alternatives: ['የራዕይዎ ምንድን ነው?'],
      keywords: ['ምሥራች', 'ድምጽ', 'ራዕይ', 'ተልእኮ'],
      answer: 'የምሥራች ድምጽ አገልግሎት (YDCS) የኢትዮጵያ ቀዳሚ ክርስቲያናዊ ሚዲያ አገልግሎት ሲሆን ከ1960ዎቹ ጀምሮ ወንጌልን ያሰራጫል።',
      priority: 90,
    });

    const match = findBestMatch('የምሥራች ድምጽ ማን ነው?', 'am', settings, [about]);
    expect(match?.entry.id).toBe('chat-kb-about-am');
    expect(String(match?.entry.answer)).toContain('ቀዳሚ ክርስቲያናዊ ሚዲያ አገልግሎት');
  });

  it('answers media questions with the listen button and streaming URL', () => {
    const mediaAnswer = 'click on listen our program button on our homepage or you can listen on listen.yemisrachdimts.org';
    const media = entry({
      id: 'chat-kb-media-en',
      intentId: 'media',
      intentName: 'media',
      question: 'Where can I listen or download media?',
      alternatives: ['where can I listen?', 'listen to our programs', 'listen online'],
      keywords: ['media', 'audio', 'download', 'listen', 'programme', 'homepage', 'online'],
      answer: mediaAnswer,
      priority: 85,
    });

    const original = findBestMatch('Where can I listen or download media?', 'en', settings, [media]);
    const short = findBestMatch('where can I listen?', 'en', settings, [media]);

    expect(original?.entry.id).toBe('chat-kb-media-en');
    expect(short?.entry.id).toBe('chat-kb-media-en');
    expect(String(original?.entry.answer)).toBe(mediaAnswer);
  });

  it('answers Amharic media questions with the listen button and streaming URL', () => {
    const answer = 'በመነሻ ገጻችን ላይ "አሁን ያዳምጡ" የሚለውን ቁልፍ ጠቅ ያድርጉ፣ ወይም በ listen.yemisrachdimts.org ላይ ማዳመጥ ይችላሉ።';
    const media = entry({
      id: 'chat-kb-media-am',
      language: 'am',
      intentId: 'media',
      intentName: 'media',
      question: 'ሚዲያውን የት ማዳመጥ ወይም ማውረድ እችላለሁ?',
      alternatives: ['የት ማዳመጥ እችላለሁ?', 'በመነሻ ገጽ ላይ ማዳመጥ'],
      keywords: ['ሚዲያ', 'ድምጽ', 'ማዳመጥ', 'መነሻ', 'ገጽ'],
      answer,
      priority: 85,
    });

    const match = findBestMatch('ሚዲያውን የት ማዳመጥ ወይም ማውረድ እችላለሁ?', 'am', settings, [media]);
    expect(match?.entry.id).toBe('chat-kb-media-am');
    expect(String(match?.entry.answer)).toBe(answer);
  });

  it('answers Oromo programme questions with the supplied translation', () => {
    const answer = 'Sagantaawwan keenya sagantaalee waaqeffannaa guyyaa guyyaa, barsiisa Macaafa Qulqulluu, faarfannaa, marii fi tamsaasa kallattiin of keessatti qabatu. Tarree sagantaalee yeroo ammaa ilaaluuf fuula Sagantaalee (Programmes) daawwadhaa; sagantaa torban keessaa ilaaluuf immoo fuula Sagantaa (Schedule) daawwadhaa.';
    const programmes = entry({
      id: 'chat-kb-programs-om',
      language: 'om',
      question: 'Sagantaa raadiyoo maal qabdu?',
      alternatives: ['taraa sagantaa', 'jeecha torbanii', 'sagantaalee keenya'],
      keywords: ['sagantaa', 'raadiyoo', 'jeecha', 'torban', 'sagantaalee'],
      answer,
      priority: 88,
    });

    const match = findBestMatch('Sagantaa raadiyoo maal qabdu?', 'om', settings, [programmes]);
    expect(match?.entry.id).toBe('chat-kb-programs-om');
    expect(String(match?.entry.answer)).toBe(answer);
  });

  it('answers Oromo media questions with the listen button and streaming URL', () => {
    const mediaAnswer = 'Fuula jalqabaa irratti button  Sagantaa Keenya Dhaaggefadhaa jedhu irratti cuqaasa. ykn listen.yemisrachdimts.org jedhu seenuun dhaggeefadhaa.';
    const media = entry({
      id: 'chat-kb-media-om',
      language: 'om',
      intentId: 'media',
      intentName: 'media',
      question: 'Miidiyaa eessaa dhaggeeffadhaa ykn buufadhaa?',
      alternatives: ['eessaa dhaggeeffachuu?', 'Fuula jalqabaa irratti dhaggeeffachuu', 'Sagantaa Keenya Dhaaggefadhaa'],
      keywords: ['miidiyaa', 'dhaggeeffachuu', 'buufachuu', 'listen', 'program', 'fuula', 'jalqabaa'],
      answer: mediaAnswer,
      priority: 85,
    });

    const match = findBestMatch('Miidiyaa eessaa dhaggeeffadhaa ykn buufadhaa?', 'om', settings, [media]);
    expect(match?.entry.id).toBe('chat-kb-media-om');
    expect(String(match?.entry.answer)).toBe(mediaAnswer);
  });

  it('uses the renamed Oromo contact question', () => {
    const contact = entry({
      id: 'chat-kb-contact-om',
      language: 'om',
      question: "Akkamitti isin qunnamuun danda'aa?",
      alternatives: ["Akkanatti isan qaba'uun danda'a?", 'lakkoofsa bilbilaa'],
      keywords: ['bilbilaa', 'imeelii', 'adiressii', 'hariiroo'],
      answer: 'Fuula hariiroo kan website koon.',
      priority: 95,
    });

    expect(findBestMatch("Akkamitti isin qunnamuun danda'aa?", 'om', settings, [contact])?.entry.id)
      .toBe('chat-kb-contact-om');
    expect(findBestMatch("Akkanatti isan qaba'uun danda'a?", 'om', settings, [contact])?.entry.id)
      .toBe('chat-kb-contact-om');
  });

  it('answers Oromo mission questions with the replacement mission text', () => {
    const missionAnswer = 'Wangeela Yesuus Kiristoos karaa miidiyaatiin labsuu fi namootaan gaʼuuf. YDCS qabiyyee Kiristaanaa oomishuu, waldoota kiristaanaa deeggaruu, kuusaa seenaa fi galmeewwan seenaa eegu, akkasumas meeshaalee qunnamtii ammayyaa fayyadamuun ergaa Yesuus Kiristoos namoota biraan gaʼuuf ergama isaa itti fufee raawwachaa jira.';
    const mission = entry({
      id: 'chat-kb-mission-om',
      intentId: 'chat-intent-mission',
      intentName: 'mission',
      language: 'om',
      question: 'Ergamni Sagalee Misirachoo maalidha?',
      alternatives: ['ergamni keessan maalidha?', 'mission of ydcs', 'what is your mission?'],
      keywords: ['ergama', 'mission', 'wangeela', 'yesuus', 'kiristoos', 'miidiyaa', 'ydcs', 'sagalee', 'missirachoo'],
      answer: missionAnswer,
      priority: 96,
    });
    const about = entry({
      id: 'chat-kb-about-om',
      language: 'om',
      question: 'Sagaleen Missirachoo maalidha?',
      alternatives: ['who is sagalee missirachoo'],
      keywords: ['sagalee', 'missirachoo'],
      answer: 'Tajaajila Sagalee Misirachoo (YDCS) ...',
    });

    const oromo = findBestMatch('ergamni keessan maalidha?', 'om', settings, [about, mission]);
    const english = findBestMatch('mission of ydcs?', 'om', settings, [about, mission]);

    expect(oromo?.entry.id).toBe('chat-kb-mission-om');
    expect(english?.entry.id).toBe('chat-kb-mission-om');
    expect(String(oromo?.entry.answer)).toBe(missionAnswer);
  });

  it('prefers the database-backed latest-tracks answer over generic news', () => {
    const latestTracks = entry({
      id: 'chat-summary-tracks-latest-en',
      question: 'Which are the latest tracks?',
      alternatives: ['which is latest tracks', 'latest tracks', 'recent songs'],
      keywords: ['latest', 'track', 'new', 'recent', 'recording', 'song', 'audio', 'media'],
      answer: 'Latest tracks from our media library.',
      priority: 92,
    });
    const news = entry({
      id: 'chat-kb-news-en',
      question: 'What is new on the website?',
      alternatives: ['latest news'],
      keywords: ['news', 'blog', 'announcement', 'latest'],
      answer: 'The Latest and Blog pages carry our newest announcements.',
      priority: 78,
    });

    const match = findBestMatch('which is latest tracks?', 'en', settings, [news, latestTracks]);
    expect(match?.entry.id).toBe('chat-summary-tracks-latest-en');
  });

  it('prefers the database-backed events summary over the generic events answer', () => {
    const events = entry({
      id: 'chat-summary-events-upcoming-en',
      question: 'What events are coming up?',
      alternatives: ['tell me events', 'upcoming events', 'when is the next event'],
      keywords: ['event', 'upcoming', 'date', 'schedule', 'location', 'starts'],
      answer: 'Upcoming events:\n1. Gospel Conference — 2026-12-01 09:00 — Addis Ababa',
      priority: 94,
    });
    const generic = entry({
      id: 'chat-kb-events-en',
      question: 'What events are coming up?',
      alternatives: ['upcoming events', 'when is the next event', 'tell me events'],
      keywords: ['event', 'upcoming', 'date', 'conference'],
      answer: 'Ask me "tell me events" and I will list the next scheduled events.',
      priority: 70,
    });

    const match = findBestMatch('tell me events', 'en', settings, [generic, events]);
    expect(match?.entry.id).toBe('chat-summary-events-upcoming-en');
    expect(String(match?.entry.answer)).toContain('Gospel Conference');
  });

  it('answers greetings from the knowledge base', () => {
    const greeting = entry({
      id: 'chat-kb-greeting-en',
      question: 'Hi',
      alternatives: ['hi', 'hello', 'hey', 'good morning'],
      keywords: ['hi', 'hello', 'hey', 'greeting'],
      answer: 'Hi! Welcome to Yemisrach Dimts.',
      priority: 88,
    });

    const match = findBestMatch('Hi', 'en', settings, [greeting]);
    expect(match?.entry.id).toBe('chat-kb-greeting-en');
    expect(String(match?.entry.answer)).toContain('Welcome to Yemisrach Dimts');
  });

  it('does not suggest greeting rows', async () => {
    vi.mocked(queryAll).mockResolvedValueOnce([
      { id: 'chat-kb-greeting-en', intent_id: 'chat-intent-greeting', intent_name: 'greeting', language: 'en', question: 'Hi', alternative_questions: '[]', keywords: '[]', answer: 'Hi!', priority: 88, source_type: 'manual', source_url: null },
      { id: 'chat-kb-history-en', intent_id: 'chat-intent-history', intent_name: 'history', language: 'en', question: 'What is our history?', alternative_questions: '[]', keywords: '[]', answer: 'Our History', priority: 84, source_type: 'manual', source_url: null },
    ]);

    const suggestions = await getSuggestions('en', 5);
    expect(suggestions).not.toContain('Hi');
    expect(suggestions).toContain('What is our history?');
  });

  it('answers our history in English, Amharic and Oromo', () => {
    const cases = [
      { lang: 'en' as const, query: 'our history', id: 'chat-kb-history-en', alternatives: ['our history', 'tell me your history'], answer: 'Our History\n1950s — Early History' },
      { lang: 'am' as const, query: 'ታሪካችን', id: 'chat-kb-history-am', alternatives: ['ታሪካችን', 'ታሪካችሁን ንገሩኝ'], answer: 'ታሪካችን\n1950ዎች' },
      { lang: 'om' as const, query: 'seenaa keenya', id: 'chat-kb-history-om', alternatives: ['seenaa keenya', 'seenaa keenyaa nii himi'], answer: 'Seenaa Keenya\n1950ffama' },
    ];

    for (const item of cases) {
      const match = findBestMatch(item.query, item.lang, settings, [entry({
        id: item.id,
        language: item.lang,
        question: item.answer.split('\n')[0],
        alternatives: item.alternatives,
        keywords: ['history', 'ታሪክ', 'seenaa'],
        answer: item.answer,
        priority: 84,
      })]);
      expect(match?.entry.id).toBe(item.id);
      expect(String(match?.entry.answer)).toContain(item.answer.split('\n')[1]);
    }
  });

  it('prefers the database-backed what-is-new summary over latest tracks', () => {
    const whatsNew = entry({
      id: 'chat-summary-whats-new-en',
      question: "What's new on the website?",
      alternatives: ["what's new", 'whats new', 'what is new', 'latest news', 'new events'],
      keywords: ['new', 'latest', 'news', 'event', 'announcement', 'blog', 'update', 'recent', 'post'],
      answer: "What's new on the website:\n1. [Event] New Event",
      priority: 96,
    });
    const tracks = entry({
      id: 'chat-summary-tracks-latest-en',
      question: 'Which are the latest tracks?',
      alternatives: ['which is latest tracks', 'latest tracks', 'recent songs'],
      keywords: ['latest', 'track', 'new', 'newest', 'recent', 'recording', 'song', 'audio', 'media'],
      answer: 'Latest tracks from our media library.',
      priority: 92,
    });

    const match = findBestMatch("what's new?", 'en', settings, [tracks, whatsNew]);
    expect(match?.entry.id).toBe('chat-summary-whats-new-en');
    expect(String(match?.entry.answer)).toContain('[Event] New Event');
  });

  it('matches vision and misspelled mission questions', () => {
    const about = entry({
      id: 'kb-about',
      question: 'What is Yemisrach Dimts?',
      alternatives: ['what is your mission?', 'what is your vision?'],
      keywords: ['yemisrach', 'dimts', 'organisation', 'ministry', 'mission', 'vision'],
    });

    expect(findBestMatch('what is a vision of ydcs?', 'en', settings, [about])?.entry.id).toBe('kb-about');
    expect(findBestMatch('vision?', 'en', settings, [about])?.entry.id).toBe('kb-about');
    expect(findBestMatch('misssion of ydcs?', 'en', settings, [about])?.entry.id).toBe('kb-about');
  });

  it('respects the confidence threshold', () => {
    const match = findBestMatch('unrelated banana question', 'en', settings, [entry()]);
    expect(match).toBeNull();
  });

  it('only matches entries in the requested language', () => {
    const match = findBestMatch('What does Yemisrach Dimts do?', 'am', settings, [entry()]);
    expect(match).toBeNull();
  });

  it('boosts the current intent and honours exclusion for follow-ups', () => {
    const about = entry({ id: 'about', intentId: 'about' });
    const contact = entry({
      id: 'contact', intentId: 'contact', question: 'How can I contact you?',
      keywords: ['contact', 'email', 'media', 'ministry'], answer: 'Email us.',
    });

    expect(findBestMatch('media ministry', 'en', settings, [contact, about], 'about')?.entry.id).toBe('about');
    expect(findBestMatch('media ministry', 'en', settings, [contact, about], 'about', 'about')?.entry.id).toBe('contact');
  });

  it('validates supported languages', () => {
    expect(isLang('om')).toBe(true);
    expect(isLang('fr')).toBe(false);
  });
});
