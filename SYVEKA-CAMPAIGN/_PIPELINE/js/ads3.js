// Hologram-style ads (H01–H04), modelled on the owner's reference clip. H01/H02 use that clip
// (slowed to 8 s) followed by motion-graphics continuation; H03/H04 are fully motion graphics.
const HC = {
  ai: ['ai', T('Tekoälyavustaja', 'AI assistant', 'المساعد الذكي'), T('Vastaa tiedoistasi', 'Answers from your data', 'يجيب من بياناتك')],
  crm: ['users', T('Asiakkaat', 'Customers', 'العملاء'), T('Yhdessä listassa', 'In one list', 'في قائمة واحدة')],
  book: ['cal', T('Varaukset', 'Bookings', 'الحجوزات'), T('Omalla linkillä', 'With your own link', 'برابطك الخاص')],
  kb: ['doc', T('Tietopankki', 'Knowledge base', 'قاعدة المعرفة'), T('Dokumenttisi', 'Your documents', 'مستنداتك')],
  deal: ['funnel', T('Kaupat', 'Deals', 'الصفقات'), T('Vaihe vaiheelta', 'Stage by stage', 'مرحلة بمرحلة')],
  cal: ['clock', T('Kalenteri', 'Calendar', 'التقويم'), T('Viikko näkyvissä', 'Your week in view', 'أسبوعك أمامك')],
};
Object.assign(ADS, {
  H01: {
    title: T('Hologrammi: ylikuormasta hallintaan', 'Hologram: from overload to control', 'هولوغرام: من الضغط إلى السيطرة'), music: 'tension', kind: 'hologram',
    tagline: T('Tekoälyavustaja, joka tuntee yrityksesi.', 'The AI assistant that knows your business.', 'مساعد ذكي يعرف شركتك.'), cta: CTA,
    scenes: [
      { t: 'footage', d: 3.6, sub: T('Liikaa kaikkea. Yhtä aikaa.', 'Too much. All at once.', 'كل شيء. في وقت واحد.'), p: { from: 0, to: 100, hook: T('Liikaa kaikkea.\n*Yhtä aikaa.*', 'Too much.\n*All at once.*', 'كل شيء.\n*في وقت واحد.*') } },
      { t: 'footage', d: 4.8, tr: 'cut', cap: T('Entä jos rinnallasi olisi avustaja?', 'What if you had an assistant at your side?', 'ماذا لو كان إلى جانبك مساعد؟'), p: { from: 101, to: 238, z0: 1.08, z1: 1.03 }, sfx: ['rise@0.1', 'chime@1.2'] },
      { t: 'holo', d: 5.6, tr: 'zoom', concept: true, cap: T('Syveka kokoaa avustajan, asiakkaat, varaukset ja tiedon yhteen työtilaan.', 'Syveka brings the assistant, customers, bookings and knowledge into one workspace.', 'سيفيكا تجمع المساعد والعملاء والحجوزات والمعرفة في مساحة عمل واحدة.'), p: { cards: [HC.ai, HC.crm, HC.book, HC.kb] }, sfx: ['pop@1.3', 'pop@1.52', 'pop@1.74', 'pop@1.96'] },
      { t: 'chatQA', d: 5.4, tr: 'up', concept: true, cap: T('Kysy – vastaus tulee omista tiedoistasi.', 'Ask — the answer comes from your own data.', 'اسأل — والإجابة تأتي من بياناتك أنت.'), p: { q: T('Onko torstaina iltapäivällä vapaata?', 'Is Thursday afternoon free?', 'هل يوجد وقت متاح بعد ظهر الخميس؟'), a: T('Torstaina on vapaata klo 13–15.', 'Thursday is free from 13 to 15.', 'يوم الخميس متاح من 13 إلى 15.'), src: T('Lähde: kalenteri', 'Source: calendar', 'المصدر: التقويم'), srcIcon: 'cal' }, sfx: ['pop@0.5', 'tick@3.4'] },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  H02: {
    title: T('Hologrammi: kutsu pilottiin', 'Hologram: pilot invitation', 'هولوغرام: دعوة للتجربة'), music: 'bright', kind: 'hologram',
    tagline: T('Mukaan pilottiin?', 'Want to join the pilot?', 'هل تودّ الانضمام للتجربة؟'), cta: CTA,
    scenes: [
      { t: 'footage', d: 4.2, sub: T('Tuttu tunne?', 'Sound familiar?', 'شعور مألوف؟'), p: { from: 0, to: 118, hook: T('Tuttu\n*tunne?*', 'Sound\n*familiar?*', 'شعور\n*مألوف؟*') } },
      { t: 'footage', d: 4.2, tr: 'cut', cap: T('Kuvittele työpäivä, jossa asiat ovat järjestyksessä.', 'Imagine a working day where things are in order.', 'تخيّل يوم عمل كل شيء فيه منظَّم.'), p: { from: 119, to: 238, z0: 1.08, z1: 1.03 }, sfx: ['rise@0.1', 'chime@1.0'] },
      { t: 'sectors', d: 5.0, tr: 'side', cap: T('Syveka on nyt maksuttomassa pilottivaiheessa.', 'Syveka is now in a free pilot phase.', 'سيفيكا الآن في مرحلة تجريبية مجانية.'), p: { kicker: T('Pilotissa mukana', 'Included in the pilot', 'ضمن التجربة'), items: [['ai', T('Tekoälyavustaja', 'AI assistant', 'المساعد الذكي')], ['users', T('CRM ja kaupat', 'CRM and deals', 'العملاء والصفقات')], ['cal', T('Kalenteri ja varaussivu', 'Calendar and booking page', 'التقويم وصفحة الحجز')], ['doc', M_KB]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05', 'tick@1.4'] },
      { t: 'ctaTap', d: 3.8, tr: 'zoom', cap: T('Aloitetaan keskustelusta.', "Let's start with a conversation.", 'لنبدأ بمحادثة.'), p: { btn: CTA }, sfx: ['pop@1.7', 'chime@1.9'] },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  H03: {
    title: T('Hologrammi: avustaja rinnallasi', 'Hologram: an assistant at your side', 'هولوغرام: مساعد إلى جانبك'), music: 'future', kind: 'hologram',
    tagline: T('Avustaja, joka tuntee yrityksesi.', 'An assistant that knows your business.', 'مساعد يعرف شركتك.'), cta: CTA,
    scenes: [
      { t: 'holo', d: 4.8, concept: true, sub: T('Kuvittele avustaja, joka tuntee yrityksesi.', 'Imagine an assistant that knows your business.', 'تخيّل مساعداً يعرف شركتك.'), p: { seed: 5, hook: T('Kuvittele avustaja, joka\n*tuntee yrityksesi.*', 'Imagine an assistant that\n*knows your business.*', 'تخيّل مساعداً\n*يعرف شركتك.*') }, sfx: ['rise@0.1', 'chime@1.0'] },
      { t: 'holo', d: 5.4, tr: 'cut', concept: true, cap: T('Se vastaa yritysprofiilistasi, dokumenteistasi ja asiakastiedoistasi.', 'It answers from your business profile, documents and customer data.', 'يجيب من ملف شركتك ومستنداتك وبيانات عملائك.'), p: { seed: 9, at: 0, cardsAt: .5, cards: [['building', T('Yritysprofiili', 'Business profile', 'ملف الشركة'), ''], HC.kb, HC.crm, HC.cal] }, sfx: ['pop@0.5', 'pop@0.72', 'pop@0.94', 'pop@1.16'] },
      { t: 'chatQA', d: 5.6, tr: 'up', concept: true, cap: T('Kysy mitä vain omasta yrityksestäsi.', 'Ask anything about your own business.', 'اسأل ما تشاء عن شركتك.'), p: { q: T('Mikä on peruutuskäytäntömme?', 'What is our cancellation policy?', 'ما هي سياسة الإلغاء لدينا؟'), a: T('Varauksen voi perua 24 tuntia ennen sovittua aikaa.', 'A booking can be cancelled up to 24 hours before the agreed time.', 'يمكن إلغاء الحجز قبل 24 ساعة من الموعد المحدد.'), src: T('Lähde: yritysprofiili', 'Source: business profile', 'المصدر: ملف الشركة'), srcIcon: 'building' }, sfx: ['pop@0.5', 'tick@3.4'] },
      { t: 'rowsCard', d: 5.2, tr: 'side', concept: true, cap: T('Se ehdottaa – ja toimii vasta, kun vahvistat.', 'It proposes — and acts only when you confirm.', 'يقترح — ولا ينفّذ إلا بعد تأكيدك.'), p: { bg: 'blue', icon: 'cal', title: T('Ehdotus: uusi varaus', 'Proposal: new booking', 'اقتراح: حجز جديد'), tag: PENDING, rows: [[T('Asiakas', 'Customer', 'العميل'), T('Anna K.', 'Anna K.', 'آنا ك.')], [T('Aika', 'Time', 'الموعد'), T('To 14:30', 'Thu 14:30', 'الخميس 14:30')]], btn: OK, done: T('Varattu', 'Booked', 'تم الحجز') }, sfx: ['pop@2.9', 'chime@3.2'] },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  H04: {
    title: T('Hologrammi: varaukset hoituvat', 'Hologram: bookings taken care of', 'هولوغرام: الحجوزات تحت السيطرة'), music: 'drive', kind: 'hologram',
    tagline: T('Oma varaussivu yrityksellesi.', 'Your own booking page.', 'صفحة حجز خاصة بشركتك.'), cta: CTA,
    scenes: [
      { t: 'phoneTag', d: 4.4, cap: T('Yksi varaus. Kolme puhelua. Neljä viestiä.', 'One booking. Three calls. Four messages.', 'حجز واحد. ثلاث مكالمات. أربع رسائل.'), sfx: ['ring@0.3', 'ring@1.5', 'ring@2.7'] },
      { t: 'holo', d: 5.4, tr: 'zoom', concept: true, cap: T('Anna varausten hoitua omalla linkilläsi.', 'Let bookings take care of themselves with your own link.', 'دع الحجوزات تتمّ عبر رابطك الخاص.'), p: { seed: 13, cards: [HC.book, HC.cal, ['link', T('Varauslinkki', 'Booking link', 'رابط الحجز'), T('Jaa asiakkaille', 'Share with customers', 'شاركه مع عملائك')], ['bell', T('Uusi varaus', 'New booking', 'حجز جديد'), T('Näkyy kalenterissa', 'Shows in your calendar', 'يظهر في تقويمك')]] }, sfx: ['rise@0.1', 'pop@1.3', 'pop@1.52', 'pop@1.74', 'pop@1.96'] },
      { t: 'booking', d: 5.0, tr: 'side', concept: true, cap: T('Asiakas valitsee itse sopivan ajan.', 'Customers pick a time that suits them.', 'العميل يختار الوقت المناسب بنفسه.'), p: { bg: 'night' }, sfx: ['pop@1.6', 'pop@2.9', 'chime@3.3'] },
      { t: 'weekView', d: 4.8, tr: 'up', concept: true, cap: T('Ja viikkosi täyttyy ilman puhelinrallia.', 'And your week fills up without the phone tag.', 'ويمتلئ أسبوعك بلا مكالمات متبادلة.'), p: Object.assign({ events: EV(T('Varaus', 'Booking', 'حجز'), T('Varaus', 'Booking', 'حجز')) }, WEEK), sfx: ['pop@0.7', 'pop@1.0', 'pop@1.3', 'pop@1.6'] },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
});
