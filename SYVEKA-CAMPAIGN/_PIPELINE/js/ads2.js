// Syveka campaign, part 2: 18 more ads (total 30).
//   G04–G06  general      S10  service (available in the pilot)
//   V01–V04  by trade (built only from pilot modules)
//   F01–F10  FUTURE services — every scene carries a "Coming soon" badge and the end card says
//            "not yet available". Copy uses conditional wording ("could", "planned").
IC.play = '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9l5 3-5 3z"/>';
const SOON_NOTE = T('Tulossa – ei vielä saatavilla', 'Coming soon — not yet available', 'قريباً — غير متاح حالياً');
const CTA_SOON = T('Kysy lisää', 'Ask us more', 'اسأل عن المزيد');
const PENDING = T('Odottaa', 'Pending', 'بانتظارك');
const soonLine = (fi, en, ar) => ({ t: 'statement', d: 4.0, tr: 'fade', sub: T('Tulossa: ' + fi, 'Coming soon: ' + en, 'قريباً: ' + ar), p: { bg: 'blue', top: 760, size: 96, text: T('Tulossa:\n*' + fi + '*', 'Coming soon:\n*' + en + '*', 'قريباً:\n*' + ar + '*') } });
const P_COLS = [T('Uusi', 'New', 'جديد'), T('Tarjous', 'Quote', 'عرض سعر'), T('Sovittu', 'Agreed', 'متَّفق عليه')];
const WEEK = { title: T('Viikko', 'Week', 'الأسبوع'), days: [T('Ma', 'Mon', 'الإثنين'), T('Ti', 'Tue', 'الثلاثاء'), T('Ke', 'Wed', 'الأربعاء'), T('To', 'Thu', 'الخميس'), T('Pe', 'Fri', 'الجمعة')] };
const EV = (a, b) => [[0, 30, 130, a, 1], [1, 190, 110, b, 1], [2, 60, 170, b, 1], [3, 260, 150, a, 1], [4, 40, 110, b, 1], [0, 380, 130, b, 1]];
const LINK = { url: '…/book/yritys/palvelu', copy: T('Kopioi', 'Copy', 'نسخ'), copied: T('Kopioitu', 'Copied', 'تم النسخ'), to: [['chat', T('Viesti', 'Message', 'رسالة')], ['mail', T('Sähköposti', 'Email', 'بريد')], ['web', T('Verkkosivu', 'Website', 'موقعك')]] };

Object.assign(ADS, {
  G04: {
    title: T('Yrityksesi tekoälykäyttöjärjestelmä', 'Your AI Business Operating System', 'نظام تشغيل أعمالك بالذكاء الاصطناعي'), music: 'luxe', kind: 'general',
    tagline: T('Yksi järjestelmä yrityksesi arkeen.', 'One system for running your business.', 'نظام واحد لإدارة أعمالك.'), cta: CTA,
    scenes: [
      { t: 'network', d: 4.4, capbg: false, cap: T('Yrityksesi tekoälykäyttöjärjestelmä.', 'Your AI Business Operating System.', 'نظام تشغيل أعمالك بالذكاء الاصطناعي.'), sfx: ['boom@0.2'] },
      { t: 'sectors', d: 5.2, tr: 'up', cap: T('Nämä ovat käytössä pilotissa jo nyt.', 'These are in the pilot today.', 'هذه متاحة في التجربة اليوم.'), p: { kicker: T('Saatavilla pilotissa', 'Available in the pilot', 'متاح في التجربة'), items: [['ai', T('Tekoälyavustaja', 'AI assistant', 'المساعد الذكي')], ['users', T('Asiakkaat ja myynti', 'Customers and sales', 'العملاء والمبيعات')], ['cal', T('Varaukset ja kalenteri', 'Bookings and calendar', 'الحجوزات والتقويم')], ['doc', M_KB]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05', 'tick@1.4'] },
      { t: 'sectors', d: 5.2, tr: 'side', cap: T('Ja lisää on tulossa.', 'And more is on the way.', 'والمزيد في الطريق.'), p: { kicker: T('Tulossa', 'Coming soon', 'قريباً'), items: [['play', T('Sisällöntuotanto', 'Content creation', 'إنشاء المحتوى')], ['bolt', T('Automaatiot', 'Automations', 'الأتمتة')], ['phone', T('Puheavustaja', 'Voice assistant', 'المساعد الصوتي')], ['web', T('Verkkosivut', 'Websites', 'المواقع')]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05', 'tick@1.4'] },
      { t: 'ecosystem', d: 4.6, tr: 'zoom', capbg: false, cap: T('Kaikki rakentuu saman työtilan ympärille.', 'Everything is built around the same workspace.', 'كل شيء يُبنى حول مساحة العمل نفسها.') },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  G05: {
    title: T('Päivä Syvekan kanssa', 'A day with Syveka', 'يوم مع سيفيكا'), music: 'warm', kind: 'general',
    tagline: T('Yksi työtila aamusta iltaan.', 'One workspace from morning to evening.', 'مساحة عمل واحدة من الصباح إلى المساء.'), cta: CTA,
    scenes: [
      { t: 'ring24', d: 4.4, sub: T('Yksi päivä. Yksi työtila.', 'One day. One workspace.', 'يوم واحد. مساحة عمل واحدة.'), p: { hook: T('Yksi päivä.\n*Yksi työtila.*', 'One day.\n*One workspace.*', 'يوم واحد.\n*مساحة عمل واحدة.*') }, sfx: ['tick@0.5', 'tick@1.0', 'tick@1.5'] },
      { t: 'rowsCard', d: 4.8, tr: 'up', concept: true, cap: T('Aamulla näet päivän yhdellä silmäyksellä.', 'In the morning you see the day at a glance.', 'في الصباح ترى يومك بنظرة واحدة.'), p: { icon: 'sun', title: T('Aamun tilanne', 'This morning', 'حالة الصباح'), tag: T('Tänään', 'Today', 'اليوم'), rows: [[T('Tapaamiset', 'Meetings', 'الاجتماعات'), T('Kalenterissa', 'In the calendar', 'في التقويم')], [T('Uudet varaukset', 'New bookings', 'حجوزات جديدة'), T('Varaussivulta', 'From the booking page', 'من صفحة الحجز')], [T('Uudet yhteystiedot', 'New contacts', 'جهات اتصال جديدة'), T('CRM:ssä', 'In the CRM', 'في إدارة العملاء')]] }, sfx: ['tick@0.6', 'tick@0.85', 'tick@1.1'] },
      { t: 'chatQA', d: 5.4, tr: 'zoom', concept: true, cap: T('Päivällä avustaja vastaa kysymyksiisi.', 'During the day the assistant answers your questions.', 'خلال النهار يجيب المساعد عن أسئلتك.'), p: { q: T('Onko torstaina iltapäivällä vapaata?', 'Is Thursday afternoon free?', 'هل يوجد وقت متاح بعد ظهر الخميس؟'), a: T('Torstaina on vapaata klo 13–15.', 'Thursday is free from 13 to 15.', 'يوم الخميس متاح من 13 إلى 15.'), src: T('Lähde: kalenteri', 'Source: calendar', 'المصدر: التقويم'), srcIcon: 'cal' }, sfx: ['pop@0.5', 'tick@3.4'] },
      { t: 'quiet', d: 4.4, tr: 'fade', cap: T('Illalla varauksia voi tulla, vaikka et ole paikalla.', "In the evening bookings can come in even when you're away.", 'في المساء قد تصل الحجوزات حتى وأنت غير موجود.'), p: { bg: 'night', icon: 'moon', text: T('Uusi varaus', 'New booking', 'حجز جديد'), sub: T('Perjantai 10:00', 'Friday 10:00', 'الجمعة 10:00') }, sfx: ['ding@1.2'] },
      { t: 'calm', d: 3.6, tr: 'fade', cap: T('Huomenna jatkat siitä, mihin jäit.', 'Tomorrow you pick up where you left off.', 'وغداً تكمل من حيث توقفت.'), p: { chip: T('Kaikki tallessa', 'Everything in place', 'كل شيء في مكانه') } },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  G06: {
    title: T('Sinä päätät', 'You decide', 'القرار لك'), music: 'tension', kind: 'general',
    tagline: T('Tekoäly, joka kysyy ennen kuin tekee.', 'AI that asks before it acts.', 'ذكاء اصطناعي يسأل قبل أن ينفّذ.'), cta: CTA,
    scenes: [
      { t: 'setpiece', d: 4.2, sub: T('Tekoäly ehdottaa. Sinä päätät.', 'AI proposes. You decide.', 'الذكاء الاصطناعي يقترح. وأنت تقرّر.'), p: { icon: 'shield', bg: 'ink', hook: T('Tekoäly ehdottaa.\n*Sinä päätät.*', 'AI proposes.\n*You decide.*', 'الذكاء الاصطناعي يقترح.\n*وأنت تقرّر.*') } },
      { t: 'rowsCard', d: 5.4, tr: 'up', concept: true, cap: T('Jokainen toiminto näytetään ensin – ja tehdään vasta, kun vahvistat.', 'Every action is shown first — and done only when you confirm.', 'كل إجراء يُعرض أولاً — ولا يُنفَّذ إلا بعد تأكيدك.'), p: { bg: 'blue', icon: 'cal', title: T('Ehdotus: uusi varaus', 'Proposal: new booking', 'اقتراح: حجز جديد'), tag: PENDING, rows: [[T('Asiakas', 'Customer', 'العميل'), T('Anna K.', 'Anna K.', 'آنا ك.')], [T('Aika', 'Time', 'الموعد'), T('To 14:30', 'Thu 14:30', 'الخميس 14:30')]], btn: OK, done: T('Varattu', 'Booked', 'تم الحجز') }, sfx: ['pop@2.9', 'chime@3.2'] },
      { t: 'sectors', d: 5.2, tr: 'side', cap: T('Sinä hallitset, kuka näkee ja tekee mitä.', 'You control who sees and does what.', 'أنت تتحكّم بمن يرى ومن يفعل ماذا.'), p: { kicker: T('Hallinta pysyy sinulla', 'You stay in control', 'التحكّم يبقى بيدك'), items: [['users', T('Roolit ja oikeudet', 'Roles and permissions', 'الأدوار والصلاحيات')], ['list', T('Tapahtumaloki', 'Audit log', 'سجلّ الأحداث')], ['shield', T('Tiedot erillään yrityksittäin', 'Data separated per organisation', 'بيانات كل شركة منفصلة')], ['doc', T('Vastaukset omista tiedoistasi', 'Answers from your own data', 'إجابات من بياناتك أنت')]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05', 'tick@1.4'] },
      { t: 'statement', d: 3.8, tr: 'fade', sub: T('Sinä pysyt ohjaksissa.', 'You stay at the wheel.', 'وتبقى القيادة بيدك.'), p: { bg: 'ink', icon: 'shield', top: 820, text: T('Sinä pysyt\n*ohjaksissa.*', 'You stay\n*at the wheel.*', 'وتبقى القيادة\n*بيدك.*') } },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  S10: {
    title: T('Profiili verkkosivuilta', 'Profile from your website', 'ملف الشركة من موقعك'), music: 'bright', kind: 'service',
    tagline: T('Alkuun ilman tyhjää lomaketta.', 'Get started without an empty form.', 'ابدأ دون نموذج فارغ.'), cta: CTA,
    scenes: [
      { t: 'svcHook', d: 4.6, sub: T('Onko sinulla jo verkkosivut? Aloita niistä.', 'Already have a website? Start from it.', 'لديك موقع إلكتروني؟ ابدأ منه.'), p: { hook: T('Onko sinulla jo verkkosivut?\n*Aloita niistä.*', 'Already have a website?\n*Start from it.*', 'لديك موقع إلكتروني؟\n*ابدأ منه.*') } },
      { t: 'form', d: 5.4, tr: 'up', concept: true, cap: T('Syveka voi esitäyttää yritysprofiilin esikatselun verkkosivujesi pohjalta.', 'Syveka can pre-fill a preview of your business profile from your website.', 'تستطيع سيفيكا تعبئة معاينة لملف شركتك اعتماداً على موقعك.'), p: { icon: 'building', title: T('Esikatselu', 'Preview', 'معاينة'), fields: [[T('Palvelut', 'Services', 'الخدمات'), T('Löydetty sivuilta', 'Found on the site', 'وُجدت في الموقع')], [T('Aukioloajat', 'Opening hours', 'ساعات العمل'), T('Löydetty sivuilta', 'Found on the site', 'وُجدت في الموقع')], [T('Yhteystiedot', 'Contact details', 'بيانات التواصل'), T('Löydetty sivuilta', 'Found on the site', 'وُجدت في الموقع')]], btn: T('Tarkista', 'Review', 'مراجعة') }, sfx: ['type@0.6', 'type@1.5', 'type@2.4', 'pop@3.5'] },
      { t: 'rowsCard', d: 5.2, tr: 'side', concept: true, cap: T('Tarkista esikatselu ja hyväksy se itse.', 'Check the preview and approve it yourself.', 'راجع المعاينة ووافق عليها بنفسك.'), p: { icon: 'building', title: T('Yritysprofiilin esikatselu', 'Business profile preview', 'معاينة ملف الشركة'), tag: PENDING, rows: [[T('Palvelut', 'Services', 'الخدمات'), T('Tarkistettu', 'Checked', 'تمت المراجعة')], [T('Aukioloajat', 'Opening hours', 'ساعات العمل'), T('Korjattu', 'Corrected', 'تم التصحيح')]], btn: T('Hyväksy', 'Approve', 'موافقة'), done: T('Hyväksytty', 'Approved', 'تمت الموافقة') }, sfx: ['pop@2.9', 'chime@3.2'] },
      { t: 'statement', d: 3.8, tr: 'fade', sub: T('Vähemmän kirjoittamista alkuun.', 'Less typing to get started.', 'كتابة أقل للبدء.'), p: { bg: 'ink', icon: 'building', top: 820, text: T('Vähemmän kirjoittamista\n*alkuun.*', 'Less typing\n*to get started.*', 'كتابة أقل\n*للبدء.*') } },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  V01: {
    title: T('Kampaamoille', 'For salons', 'للصالونات'), music: 'warm', kind: 'trade',
    tagline: T('Syveka kampaamoille ja kauneusalalle.', 'Syveka for salons and beauty businesses.', 'سيفيكا للصالونات ومراكز التجميل.'), cta: CTA,
    scenes: [
      { t: 'setpiece', d: 4.4, sub: T('Kampaamossa kädet ovat täynnä – ja puhelin soi.', 'At the salon your hands are full — and the phone rings.', 'في الصالون يداك مشغولتان — والهاتف يرنّ.'), p: { icon: 'scissors', bg: 'rose', hook: T('Kädet täynnä.\n*Ja puhelin soi.*', 'Hands full.\n*And the phone rings.*', 'يداك مشغولتان.\n*والهاتف يرنّ.*') } },
      { t: 'linkShare', d: 4.8, tr: 'zoom', cap: T('Jaa varauslinkki – asiakas varaa itse.', 'Share a booking link — customers book themselves.', 'شارك رابط الحجز — والعميل يحجز بنفسه.'), p: LINK, sfx: ['pop@1.5', 'tick@2.3', 'tick@2.55', 'tick@2.8'] },
      { t: 'contacts', d: 5.4, tr: 'side', concept: true, cap: T('Asiakkaat ja muistiinpanot yhdessä paikassa.', 'Customers and notes in one place.', 'العملاء والملاحظات في مكان واحد.'), p: { title: T('Asiakkaat', 'Customers', 'العملاء'), search: T('Anna', 'Anna', 'آنا'), keep: 0, rows: [['AK', T('Anna K.', 'Anna K.', 'آنا ك.'), T('Värjäys ja leikkaus', 'Colour and cut', 'صبغ وقصّ'), T('Asiakas', 'Customer', 'عميل'), 1], ['SH', T('Sara H.', 'Sara H.', 'سارة هـ.'), T('Leikkaus', 'Haircut', 'قصّ الشعر'), T('Asiakas', 'Customer', 'عميل'), 1], ['ML', T('Mia L.', 'Mia L.', 'ميا ل.'), T('Kysyi juhlakampausta', 'Asked about occasion styling', 'سألت عن تسريحة مناسبات'), T('Liidi', 'Lead', 'محتمل'), 0]] }, sfx: ['type@2.4'] },
      { t: 'chatQA', d: 5.4, tr: 'up', concept: true, cap: T('Kysy avustajalta – se vastaa omista tiedoistasi.', 'Ask the assistant — it answers from your own data.', 'اسأل المساعد — يجيبك من بياناتك.'), p: { q: T('Mitä Anna toivoi viimeksi?', 'What did Anna ask for last time?', 'ماذا طلبت آنا آخر مرة؟'), a: T('Muistiinpanon mukaan Anna toivoo iltapäiväaikoja.', 'According to the note, Anna prefers afternoon appointments.', 'بحسب الملاحظة، تفضّل آنا مواعيد بعد الظهر.'), src: T('Lähde: asiakkaan muistiinpano', 'Source: customer note', 'المصدر: ملاحظة العميل'), srcIcon: 'users' }, sfx: ['pop@0.5', 'tick@3.4'] },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  V02: {
    title: T('Korjaamoille', 'For workshops', 'لورش السيارات'), music: 'drive', kind: 'trade',
    tagline: T('Syveka autokorjaamoille.', 'Syveka for auto workshops.', 'سيفيكا لورش السيارات.'), cta: CTA,
    scenes: [
      { t: 'ringing', d: 4.4, sub: T('Korjaamolla kädet ovat kiinni töissä.', 'At the workshop your hands are busy.', 'في الورشة يداك مشغولتان بالعمل.'), p: { hook: T('Korjaamolla kädet ovat\n*kiinni töissä.*', 'At the workshop\n*your hands are busy.*', 'في الورشة\n*يداك مشغولتان.*') }, sfx: ['ring@0.9', 'ring@2.3'] },
      { t: 'booking', d: 5.0, tr: 'side', concept: true, cap: T('Asiakas varaa huoltoajan itse varauslinkistä.', 'Customers book a service slot themselves from your link.', 'العميل يحجز موعد الصيانة بنفسه عبر رابطك.'), p: { bg: 'steel' }, sfx: ['pop@1.6', 'pop@2.9', 'chime@3.3'] },
      { t: 'pipeline', d: 5.4, tr: 'up', concept: true, cap: T('Tarjoukset ja työt etenevät vaihe vaiheelta.', 'Quotes and jobs move forward stage by stage.', 'العروض والأعمال تتقدّم مرحلة بمرحلة.'), p: { cols: P_COLS, cards: [[T('Määräaikaishuolto', 'Scheduled service', 'صيانة دورية'), T('Uusi kysely', 'New inquiry', 'طلب جديد'), 0, 0, null], [T('Jarruremontti', 'Brake repair', 'إصلاح المكابح'), T('Tarjouspyyntö', 'Quote requested', 'طلب عرض سعر'), 0, 1, [1, 1.7, 0]], [T('Renkaanvaihto', 'Tyre change', 'تبديل الإطارات'), T('Aika sovittu', 'Time agreed', 'تم تحديد موعد'), 2, 0, null], [T('Ilmastointihuolto', 'A/C service', 'صيانة التكييف'), T('Tarjous lähetetty', 'Quote sent', 'أُرسل العرض'), 1, 1, [2, 2.8, 1]]] }, sfx: ['tick@1.7', 'tick@2.8'] },
      { t: 'weekView', d: 5.0, tr: 'side', concept: true, cap: T('Viikon työt yhdessä kalenterissa.', "The week's jobs in one calendar.", 'أعمال الأسبوع في تقويم واحد.'), p: Object.assign({ events: EV(T('Huolto', 'Service', 'صيانة'), T('Renkaat', 'Tyres', 'إطارات')) }, WEEK), sfx: ['pop@0.7', 'pop@1.0', 'pop@1.3', 'pop@1.6'] },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  V03: {
    title: T('Siivousyrityksille', 'For cleaning companies', 'لشركات التنظيف'), music: 'bright', kind: 'trade',
    tagline: T('Syveka siivousalalle.', 'Syveka for cleaning businesses.', 'سيفيكا لشركات التنظيف.'), cta: CTA,
    scenes: [
      { t: 'setpiece', d: 4.4, sub: T('Tarjouspyyntöjä tulee joka suunnasta.', 'Quote requests come from every direction.', 'طلبات عروض الأسعار تأتي من كل اتجاه.'), p: { icon: 'sparkle', bg: 'fresh', hook: T('Tarjouspyyntöjä tulee\n*joka suunnasta.*', 'Quote requests come\n*from every direction.*', 'طلبات عروض الأسعار\n*من كل اتجاه.*') } },
      { t: 'gather', d: 4.4, tr: 'zoom', cap: T('Kokoa yhteydenotot yhteen paikkaan.', 'Bring the inquiries into one place.', 'اجمع الطلبات في مكان واحد.'), sfx: ['rise@0.2', 'chime@2.2'] },
      { t: 'pipeline', d: 5.4, tr: 'up', concept: true, cap: T('Uusi, tarjottu, sovittu – näet tilanteen heti.', 'New, quoted, agreed — see where things stand.', 'جديد، تم التسعير، متَّفق عليه — ترى الوضع فوراً.'), p: { cols: P_COLS, cards: [[T('Kotisiivous', 'Home cleaning', 'تنظيف منزلي'), T('Uusi kysely', 'New inquiry', 'طلب جديد'), 0, 0, null], [T('Toimistosiivous', 'Office cleaning', 'تنظيف مكاتب'), T('Tarjouspyyntö', 'Quote requested', 'طلب عرض سعر'), 0, 1, [1, 1.7, 0]], [T('Muuttosiivous', 'Move-out cleaning', 'تنظيف عند الانتقال'), T('Aika sovittu', 'Time agreed', 'تم تحديد موعد'), 2, 0, null], [T('Ikkunanpesu', 'Window cleaning', 'تنظيف النوافذ'), T('Tarjous lähetetty', 'Quote sent', 'أُرسل العرض'), 1, 1, [2, 2.8, 1]]] }, sfx: ['tick@1.7', 'tick@2.8'] },
      { t: 'chatQA', d: 5.6, tr: 'side', concept: true, cap: T('Avustaja vastaa palvelukuvaustesi pohjalta.', 'The assistant answers from your service descriptions.', 'المساعد يجيب اعتماداً على وصف خدماتك.'), p: { q: T('Mitä muuttosiivoukseen kuuluu?', 'What does a move-out cleaning include?', 'ماذا يشمل تنظيف الانتقال؟'), a: T('Palvelukuvauksen mukaan: keittiö, kylpyhuone, lattiat ja ikkunat.', 'Per the service description: kitchen, bathroom, floors and windows.', 'بحسب وصف الخدمة: المطبخ والحمّام والأرضيات والنوافذ.'), src: T('Lähde: palvelukuvaus.pdf', 'Source: service-description.pdf', 'المصدر: وصف-الخدمة.pdf') }, sfx: ['pop@0.5', 'tick@3.4'] },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  V04: {
    title: T('Yksinyrittäjille', 'For solo entrepreneurs', 'لأصحاب العمل المستقل'), music: 'tension', kind: 'trade',
    tagline: T('Syveka yksinyrittäjälle.', 'Syveka for the solo entrepreneur.', 'سيفيكا لصاحب العمل المستقل.'), cta: CTA,
    scenes: [
      { t: 'setpiece', d: 4.2, sub: T('Yksinyrittäjänä sinä olet koko toimisto.', 'As a solo entrepreneur, you are the whole office.', 'في العمل المستقل، أنت المكتب كله.'), p: { icon: 'user', bg: 'ink', hook: T('Sinä olet\n*koko toimisto.*', 'You are\n*the whole office.*', 'أنت\n*المكتب كله.*') } },
      { t: 'sectors', d: 5.4, tr: 'up', cap: T('Yksi työtila, joka pitää langat käsissäsi.', 'One workspace that keeps the threads in your hands.', 'مساحة عمل واحدة تُبقي كل الخيوط بيدك.'), p: { kicker: T('Yksi työtila', 'One workspace', 'مساحة عمل واحدة'), items: [['link', T('Tapaamiset varauslinkillä', 'Meetings by booking link', 'اللقاءات عبر رابط الحجز')], ['users', T('Asiakkaat ja muistiinpanot', 'Customers and notes', 'العملاء والملاحظات')], ['funnel', T('Kaupat vaihe vaiheelta', 'Deals stage by stage', 'الصفقات مرحلة بمرحلة')], ['doc', T('Vastaukset omista dokumenteista', 'Answers from your documents', 'إجابات من مستنداتك')]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05', 'tick@1.4'] },
      { t: 'weekView', d: 5.2, tr: 'side', concept: true, cap: T('Tapaamiset kalenterissa ilman viestiketjuja.', 'Meetings in the calendar, without the message threads.', 'اللقاءات في التقويم، دون سلاسل الرسائل.'), p: Object.assign({ events: EV(T('Tapaaminen', 'Meeting', 'اجتماع'), T('Varaus', 'Booking', 'حجز')) }, WEEK), sfx: ['pop@0.7', 'pop@1.0', 'pop@1.3', 'pop@1.6'] },
      { t: 'statement', d: 3.8, tr: 'fade', sub: T('Vähemmän säätöä. Enemmän asiakastyötä.', 'Less admin. More client work.', 'إدارة أقل. وعمل أكثر مع العملاء.'), p: { bg: 'ink', icon: 'user', top: 820, text: T('Vähemmän säätöä.\n*Enemmän asiakastyötä.*', 'Less admin.\n*More client work.*', 'إدارة أقل.\n*وعمل أكثر مع العملاء.*'), size: 92 } },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },

  // ======================= FUTURE SERVICES (coming soon) =======================
  F01: {
    title: T('Puheavustaja', 'Voice assistant', 'المساعد الصوتي'), music: 'future', kind: 'future', soon: true,
    tagline: T('Puheavustaja – tulossa Syvekaan.', 'Voice assistant — coming to Syveka.', 'المساعد الصوتي — قريباً في سيفيكا.'), cta: CTA_SOON,
    scenes: [
      { t: 'ringing', d: 4.4, sub: T('Entä jos puhelimeen vastaisi avustaja?', 'What if an assistant answered the phone?', 'ماذا لو ردّ مساعد على الهاتف؟'), p: { icon: 'phone', hook: T('Entä jos puhelimeen vastaisi\n*avustaja?*', 'What if an assistant\n*answered the phone?*', 'ماذا لو ردّ\n*مساعد على الهاتف؟*') }, sfx: ['ring@0.9', 'ring@2.3'] },
      { t: 'rowsCard', d: 5.2, tr: 'up', cap: T('Puheavustaja voisi ottaa puhelun vastaan ja kirjata asian.', 'A voice assistant could take the call and log the request.', 'يمكن لمساعد صوتي أن يستقبل المكالمة ويسجّل الطلب.'), p: { bg: 'blue', icon: 'phone', title: T('Puhelu vastaanotettu', 'Call received', 'تم استقبال المكالمة'), tag: T('Kirjattu', 'Logged', 'مسجَّل'), tagCls: 'g', rows: [[T('Soittaja', 'Caller', 'المتصل'), T('Uusi asiakas', 'New customer', 'عميل جديد')], [T('Asia', 'Topic', 'الموضوع'), T('Ajanvaraus', 'Booking', 'حجز موعد')], [T('Seuraava askel', 'Next step', 'الخطوة التالية'), T('Soitto takaisin', 'Call back', 'معاودة الاتصال')]] }, sfx: ['tick@0.6', 'tick@0.85', 'tick@1.1'] },
      { t: 'quiet', d: 4.4, tr: 'fade', cap: T('Sinä saisit yhteenvedon ja päättäisit jatkosta.', 'You would get a summary and decide what happens next.', 'ويصلك ملخّص، وأنت تقرّر الخطوة التالية.'), p: { bg: 'night', icon: 'phone', text: T('Yhteenveto puhelusta', 'Call summary', 'ملخّص المكالمة'), sub: T('Ajanvarauspyyntö · torstai', 'Booking request · Thursday', 'طلب حجز · الخميس') }, sfx: ['ding@1.2'] },
      soonLine('puheavustaja.', 'voice assistant.', 'المساعد الصوتي.'),
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  F02: {
    title: T('Automaatiot', 'Automations', 'الأتمتة'), music: 'drive', kind: 'future', soon: true,
    tagline: T('Automaatiot – tulossa Syvekaan.', 'Automations — coming to Syveka.', 'الأتمتة — قريباً في سيفيكا.'), cta: CTA_SOON,
    scenes: [
      { t: 'setpiece', d: 4.0, sub: T('Samat rutiinit. Joka päivä.', 'The same routines. Every day.', 'المهام نفسها. كل يوم.'), p: { icon: 'bolt', bg: 'ink', hook: T('Samat rutiinit.\n*Joka päivä.*', 'The same routines.\n*Every day.*', 'المهام نفسها.\n*كل يوم.*') } },
      { t: 'repeat', d: 4.6, tr: 'side', cap: T('Vahvistukset, kirjaukset, muistutukset – käsin.', 'Confirmations, data entry, reminders — by hand.', 'تأكيدات، إدخالات، تذكيرات — يدوياً.'), sfx: ['pop@0.3', 'pop@0.8', 'pop@1.3', 'pop@1.8', 'pop@2.3'] },
      { t: 'automate', d: 4.8, tr: 'zoom', cap: T('Automaatiot voisivat hoitaa toistuvat vaiheet puolestasi.', 'Automations could handle the repetitive steps for you.', 'يمكن للأتمتة أن تتولّى الخطوات المتكررة عنك.'), sfx: ['rise@0.2', 'chime@2.6'] },
      { t: 'blueprint', d: 5.0, tr: 'up', cap: T('Sinä määrittäisit säännöt. Syveka toistaisi ne.', 'You would set the rules. Syveka would repeat them.', 'أنت تحدّد القواعد. وسيفيكا تكرّرها.'), sfx: ['tick@0.6', 'tick@1.1', 'tick@1.6'] },
      soonLine('automaatiot.', 'automations.', 'الأتمتة.'),
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  F03: {
    title: T('Jaettu postilaatikko', 'Shared inbox', 'صندوق وارد مشترك'), music: 'tension', kind: 'future', soon: true,
    tagline: T('Jaettu postilaatikko – tulossa Syvekaan.', 'Shared inbox — coming to Syveka.', 'صندوق الوارد المشترك — قريباً في سيفيكا.'), cta: CTA_SOON,
    scenes: [
      { t: 'storm', d: 4.6, sub: T('Missä se asiakkaan viesti olikaan?', "Where was that customer's message again?", 'أين كانت رسالة ذلك العميل؟'), p: { hook: T('Missä se asiakkaan viesti\n*olikaan?*', "Where was that customer's message\n*again?*", 'أين كانت\n*رسالة ذلك العميل؟*') }, sfx: ['ding@0.2', 'ding@0.65', 'ding@1.1', 'ding@1.5'] },
      { t: 'sorted', d: 5.2, tr: 'up', cap: T('Jaettu postilaatikko kokoaisi asiakasviestit yhteen näkymään.', 'A shared inbox would bring customer messages into one view.', 'صندوق وارد مشترك يجمع رسائل العملاء في عرض واحد.'), sfx: ['tick@0.3', 'tick@0.62', 'tick@0.94', 'tick@1.26'] },
      { t: 'sectors', d: 5.0, tr: 'side', cap: T('Koko tiimi näkisi saman tilanteen.', 'The whole team would see the same picture.', 'ويرى الفريق كله الصورة نفسها.'), p: { kicker: T('Suunnitteilla', 'Planned', 'ضمن الخطة'), items: [['mail', T('Sähköposti yhdessä näkymässä', 'Email in one view', 'البريد في عرض واحد')], ['users', T('Yhteinen koko tiimille', 'Shared by the whole team', 'مشترك للفريق كله')], ['user', T('Yhteys asiakastietoihin', 'Linked to customer records', 'مرتبط ببيانات العميل')]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05'] },
      soonLine('jaettu postilaatikko.', 'shared inbox.', 'صندوق الوارد المشترك.'),
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  F04: {
    title: T('Viestikanavat', 'Messaging channels', 'قنوات المراسلة'), music: 'bright', kind: 'future', soon: true,
    tagline: T('Viestikanavat – tulossa Syvekaan.', 'Messaging channels — coming to Syveka.', 'قنوات المراسلة — قريباً في سيفيكا.'), cta: CTA_SOON,
    scenes: [
      { t: 'setpiece', d: 4.2, sub: T('Asiakkaasi viestivät monessa kanavassa.', 'Your customers message you on many channels.', 'عملاؤك يراسلونك عبر قنوات كثيرة.'), p: { icon: 'chat', bg: 'fresh', hook: T('Asiakkaasi viestivät\n*monessa kanavassa.*', 'Your customers message you\n*on many channels.*', 'عملاؤك يراسلونك\n*عبر قنوات كثيرة.*') } },
      { t: 'features', d: 5.4, tr: 'up', cap: T('Tavoitteena on tuoda kanavat samaan työtilaan.', 'The goal is to bring the channels into the same workspace.', 'الهدف: جمع القنوات في مساحة العمل نفسها.'), p: { items: [['chat', 'WhatsApp', T('Suunnitteilla', 'Planned', 'ضمن الخطة')], ['phone', T('Tekstiviesti', 'SMS', 'رسائل نصية'), T('Suunnitteilla', 'Planned', 'ضمن الخطة')], ['web', T('Verkkochat', 'Web chat', 'محادثة الموقع'), T('Suunnitteilla', 'Planned', 'ضمن الخطة')], ['mail', T('Sähköposti', 'Email', 'البريد'), T('Suunnitteilla', 'Planned', 'ضمن الخطة')]] }, sfx: ['pop@0.25', 'pop@0.57', 'pop@0.89', 'pop@1.21'] },
      { t: 'funnel', d: 4.6, tr: 'zoom', cap: T('Yksi paikka, josta vastaat kaikkiin.', 'One place to reply to everyone.', 'مكان واحد تردّ منه على الجميع.'), sfx: ['rise@0.3', 'chime@2.1'] },
      soonLine('viestikanavat.', 'messaging channels.', 'قنوات المراسلة.'),
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  F05: {
    title: T('Sisältöstudio: kuvat', 'Content studio: images', 'استوديو المحتوى: الصور'), music: 'luxe', kind: 'future', soon: true,
    tagline: T('Sisältöstudio – tulossa Syvekaan.', 'Content studio — coming to Syveka.', 'استوديو المحتوى — قريباً في سيفيكا.'), cta: CTA_SOON,
    scenes: [
      { t: 'setpiece', d: 4.4, sub: T('Tuotekuva otettu puhelimella. Näyttääkö se myyvältä?', 'A product photo taken on a phone. Does it sell?', 'صورة منتج بالهاتف. هل تبدو جذّابة للبيع؟'), p: { icon: 'sparkle', bg: 'night', hook: T('Tuotekuva puhelimella.\n*Näyttääkö se myyvältä?*', 'A product photo on a phone.\n*Does it sell?*', 'صورة منتج بالهاتف.\n*هل تبدو جذّابة للبيع؟*') } },
      { t: 'features', d: 5.4, tr: 'up', cap: T('Sisältöstudio voisi luoda yhdestä kuvasta useita tyylejä.', 'A content studio could create several styles from one photo.', 'يمكن لاستوديو المحتوى أن ينشئ عدة أنماط من صورة واحدة.'), p: { items: [['sparkle', T('Uusi tausta', 'New background', 'خلفية جديدة'), T('Tunnelma kohdalleen', 'The right mood', 'الأجواء المناسبة')], ['web', T('Eri tyylit', 'Different styles', 'أنماط مختلفة'), T('Yhdestä kuvasta', 'From one photo', 'من صورة واحدة')], ['phone', T('Somekoot', 'Social sizes', 'مقاسات التواصل'), T('Valmiit mittasuhteet', 'Ready proportions', 'أبعاد جاهزة')], ['note', T('Kuvatekstit', 'Captions', 'نصوص مرافقة'), T('Ehdotukset', 'Suggestions', 'اقتراحات')]] }, sfx: ['pop@0.25', 'pop@0.57', 'pop@0.89', 'pop@1.21'] },
      { t: 'steps', d: 5.0, tr: 'side', cap: T('Sinä valitsisit ja hyväksyisit lopputuloksen.', 'You would choose and approve the result.', 'وأنت تختار النتيجة وتوافق عليها.'), p: { steps: [T('Lataa kuva', 'Upload a photo', 'ارفع صورة'), T('Valitse tyyli', 'Choose a style', 'اختر نمطاً'), T('Hyväksy tulos', 'Approve the result', 'وافق على النتيجة')] }, sfx: ['tick@0.4', 'tick@1.3', 'tick@2.2'] },
      soonLine('sisältöstudio.', 'content studio.', 'استوديو المحتوى.'),
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  F06: {
    title: T('Sisältöstudio: video ja some', 'Content studio: video and social', 'استوديو المحتوى: الفيديو والتواصل'), music: 'drive', kind: 'future', soon: true,
    tagline: T('Kuvasta videoksi – tulossa Syvekaan.', 'From photo to video — coming to Syveka.', 'من الصورة إلى الفيديو — قريباً في سيفيكا.'), cta: CTA_SOON,
    scenes: [
      { t: 'setpiece', d: 4.2, sub: T('Yksi kuva. Lyhyt video someen.', 'One photo. A short video for social.', 'صورة واحدة. وفيديو قصير للتواصل الاجتماعي.'), p: { icon: 'play', bg: 'ink', hook: T('Yksi kuva.\n*Lyhyt video someen.*', 'One photo.\n*A short video for social.*', 'صورة واحدة.\n*وفيديو قصير للتواصل.*') } },
      { t: 'steps', d: 5.2, tr: 'up', cap: T('Kuvasta syntyisi lyhyt video, jonka sinä hyväksyt.', 'A photo would become a short video that you approve.', 'تتحوّل الصورة إلى فيديو قصير توافق عليه أنت.'), p: { steps: [T('Valitse kuva', 'Pick a photo', 'اختر صورة'), T('Luo lyhyt video', 'Create a short video', 'أنشئ فيديو قصيراً'), T('Hyväksy ja julkaise', 'Approve and publish', 'وافق وانشر')] }, sfx: ['tick@0.4', 'tick@1.3', 'tick@2.2'] },
      { t: 'sectors', d: 4.8, tr: 'side', cap: T('Julkaisu sosiaaliseen mediaan on suunnitteilla.', 'Publishing to social media is planned.', 'النشر على وسائل التواصل ضمن الخطة.'), p: { kicker: T('Suunnitteilla', 'Planned', 'ضمن الخطة'), items: [['play', T('Lyhyet videot', 'Short videos', 'فيديوهات قصيرة')], ['note', T('Kuvatekstit', 'Captions', 'نصوص مرافقة')], ['globe', T('Julkaisu someen', 'Publishing to social', 'النشر على وسائل التواصل')]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05'] },
      soonLine('kuvasta videoksi.', 'photo to video.', 'من الصورة إلى الفيديو.'),
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  F07: {
    title: T('Verkkosivut', 'Websites', 'المواقع الإلكترونية'), music: 'bright', kind: 'future', soon: true,
    tagline: T('Verkkosivut – tulossa Syvekaan.', 'Websites — coming to Syveka.', 'المواقع — قريباً في سيفيكا.'), cta: CTA_SOON,
    scenes: [
      { t: 'svcHook', d: 4.6, sub: T('Uusi yritys? Aloita verkkosivuista.', 'New business? Start with a website.', 'مشروع جديد؟ ابدأ بالموقع.'), p: { hook: T('Uusi yritys?\n*Aloita verkkosivuista.*', 'New business?\n*Start with a website.*', 'مشروع جديد؟\n*ابدأ بالموقع.*') } },
      { t: 'wire', d: 3.8, tr: 'up', cap: T('Selkeä rakenne.', 'A clear structure.', 'بنية واضحة.'), sfx: ['tick@0.3', 'tick@0.7', 'tick@1.1', 'tick@1.5'] },
      { t: 'wire', d: 4.0, tr: 'fade', cap: T('Valmis ulkoasu.', 'A finished look.', 'ومظهر جاهز.'), p: { styled: true }, sfx: ['rise@0.2'] },
      { t: 'responsive', d: 4.8, tr: 'zoom', cap: T('Tavoitteena: verkkosivut suoraan Syvekasta, kaikille laitteille.', 'The goal: a website straight from Syveka, for every device.', 'الهدف: موقع مباشرة من سيفيكا، لكل الأجهزة.') },
      soonLine('verkkosivut.', 'websites.', 'المواقع.'),
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  F08: {
    title: T('Analytiikka', 'Analytics', 'التحليلات'), music: 'tension', kind: 'future', soon: true,
    tagline: T('Analytiikka – tulossa Syvekaan.', 'Analytics — coming to Syveka.', 'التحليلات — قريباً في سيفيكا.'), cta: CTA_SOON,
    scenes: [
      { t: 'growHook', d: 4.8, sub: T('Miten yritykselläsi oikeasti menee?', 'How is your business really doing?', 'كيف حال عملك فعلاً؟'), p: { hook: T('Miten yritykselläsi\n*oikeasti menee?*', 'How is your business\n*really doing?*', 'كيف حال عملك\n*فعلاً؟*') }, sfx: ['tick@0.5', 'tick@0.72', 'tick@0.94', 'tick@1.16', 'tick@1.38'] },
      { t: 'sectors', d: 5.6, tr: 'up', cap: T('Analytiikka kokoaisi myynnin ja avustajan käytön yhteen näkymään.', 'Analytics would bring sales and assistant usage into one view.', 'التحليلات تجمع المبيعات واستخدام المساعد في عرض واحد.'), p: { kicker: T('Suunnitteilla', 'Planned', 'ضمن الخطة'), items: [['funnel', T('Myyntisuppilo', 'Sales funnel', 'قمع المبيعات')], ['ai', T('Avustajan käyttö', 'Assistant usage', 'استخدام المساعد')], ['clock', T('Kehitys ajan myötä', 'Trends over time', 'التطوّر عبر الزمن')]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05'] },
      { t: 'statement', d: 4.2, tr: 'fade', sub: T('Päätökset tiedon pohjalta.', 'Decisions based on what you can see.', 'قرارات مبنية على ما تراه.'), p: { bg: 'ink', icon: 'funnel', top: 820, text: T('Päätökset\n*tiedon pohjalta.*', 'Decisions based on\n*what you can see.*', 'قرارات مبنية\n*على ما تراه.*') } },
      soonLine('analytiikka.', 'analytics.', 'التحليلات.'),
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  F09: {
    title: T('Kalenterisynkronointi', 'Calendar sync', 'مزامنة التقويم'), music: 'warm', kind: 'future', soon: true,
    tagline: T('Kalenterisynkronointi – tulossa Syvekaan.', 'Calendar sync — coming to Syveka.', 'مزامنة التقويم — قريباً في سيفيكا.'), cta: CTA_SOON,
    scenes: [
      { t: 'calendar', d: 4.6, sub: T('Kaksi kalenteria. Kumpi on oikeassa?', 'Two calendars. Which one is right?', 'تقويمان. أيّهما الصحيح؟'), p: { hook: T('Kaksi kalenteria.\n*Kumpi on oikeassa?*', 'Two calendars.\n*Which one is right?*', 'تقويمان.\n*أيّهما الصحيح؟*') }, sfx: ['tick@1.4'] },
      { t: 'features', d: 5.4, tr: 'up', cap: T('Synkronointi yhdistäisi nykyisen kalenterisi Syvekaan.', 'Sync would connect your existing calendar to Syveka.', 'المزامنة تربط تقويمك الحالي بسيفيكا.'), p: { items: [['cal', 'Google', T('Kalenteri', 'Calendar', 'التقويم')], ['cal', 'Microsoft', T('Kalenteri', 'Calendar', 'التقويم')], ['ai', 'Syveka', T('Kalenteri', 'Calendar', 'التقويم')], ['link', T('Varaussivu', 'Booking page', 'صفحة الحجز'), T('Vapaat ajat', 'Free times', 'الأوقات المتاحة')]] }, sfx: ['pop@0.25', 'pop@0.57', 'pop@0.89', 'pop@1.21'] },
      { t: 'weekView', d: 5.0, tr: 'side', cap: T('Varatut ajat näkyisivät samassa näkymässä.', 'Booked times would appear in the same view.', 'وتظهر المواعيد المحجوزة في العرض نفسه.'), p: Object.assign({ events: EV(T('Tapaaminen', 'Meeting', 'اجتماع'), T('Varaus', 'Booking', 'حجز')) }, WEEK), sfx: ['pop@0.7', 'pop@1.0', 'pop@1.3', 'pop@1.6'] },
      soonLine('kalenterisynkronointi.', 'calendar sync.', 'مزامنة التقويم.'),
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  F10: {
    title: T('Varausmuistutukset', 'Booking reminders', 'تذكيرات الحجز'), music: 'bright', kind: 'future', soon: true,
    tagline: T('Varausmuistutukset – tulossa Syvekaan.', 'Booking reminders — coming to Syveka.', 'تذكيرات الحجز — قريباً في سيفيكا.'), cta: CTA_SOON,
    scenes: [
      { t: 'setpiece', d: 4.2, sub: T('Unohtunut aika on tyhjä paikka kalenterissa.', 'A forgotten appointment is an empty slot in your calendar.', 'الموعد المنسيّ خانة فارغة في تقويمك.'), p: { icon: 'bell', bg: 'ink', hook: T('Unohtunut aika on\n*tyhjä paikka kalenterissa.*', 'A forgotten appointment is\n*an empty slot.*', 'الموعد المنسيّ\n*خانة فارغة في تقويمك.*') } },
      { t: 'quiet', d: 4.6, tr: 'fade', cap: T('Muistutus voisi lähteä asiakkaalle ennen varattua aikaa.', 'A reminder could go out to the customer before the appointment.', 'يمكن إرسال تذكير للعميل قبل موعده.'), p: { bg: 'night', icon: 'bell', text: T('Muistutus asiakkaalle', 'Reminder to customer', 'تذكير للعميل'), sub: T('Huomenna klo 14:30', 'Tomorrow at 14:30', 'غداً الساعة 14:30') }, sfx: ['ding@1.2'] },
      { t: 'rowsCard', d: 5.2, tr: 'up', cap: T('Vahvistus, muistutus ja muutoslinkki samassa ketjussa.', 'Confirmation, reminder and change link in one flow.', 'تأكيد، وتذكير، ورابط للتعديل — في مسار واحد.'), p: { icon: 'cal', title: T('Varaus', 'Booking', 'الحجز'), tag: T('Vahvistettu', 'Confirmed', 'مؤكَّد'), tagCls: 'g', rows: [[T('Vahvistus', 'Confirmation', 'التأكيد'), T('Heti', 'Right away', 'فوراً')], [T('Muistutus', 'Reminder', 'التذكير'), T('Päivää ennen', 'The day before', 'قبل يوم')], [T('Muutos', 'Changes', 'التعديل'), T('Linkistä', 'From a link', 'عبر رابط')]] }, sfx: ['tick@0.6', 'tick@0.85', 'tick@1.1'] },
      soonLine('varausmuistutukset.', 'booking reminders.', 'تذكيرات الحجز.'),
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
});
