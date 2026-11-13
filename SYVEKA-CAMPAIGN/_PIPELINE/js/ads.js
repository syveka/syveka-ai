// Syveka campaign content: 3 general ads (G01–G03) + 9 service ads (S01–S09) × FI / EN / AR.
// Only modules documented as part of the controlled free pilot are advertised. Voice AI, workflows,
// inbox, Creator Studio, website building, prices and compliance claims are deliberately absent.
// CONTACT: set to a verified address to replace the pilot note on every end card, then re-render.
const CONTACT = '';
const PILOT_NOTE = T('Maksuton pilottivaihe · rajattu määrä yrityksiä', 'Free pilot phase · limited number of businesses', 'مرحلة تجريبية مجانية · لعدد محدود من الشركات');
const CTA = T('Kysy pilotista', 'Ask about the pilot', 'اسأل عن الانضمام للتجربة');
const OK = T('Vahvista', 'Confirm', 'تأكيد');
const M_AI = T('Avustaja', 'Assistant', 'المساعد'), M_CRM = T('CRM', 'CRM', 'إدارة العملاء'), M_BOOK = T('Ajanvaraus', 'Booking', 'الحجز'), M_KB = T('Tietopankki', 'Knowledge base', 'قاعدة المعرفة');

const ADS = {
  G01: {
    title: T('Brändifilmi', 'Brand film', 'فيلم العلامة'), music: 'luxe', kind: 'general',
    tagline: T('Tekoälyavustaja, joka tuntee yrityksesi.', 'The AI assistant that knows your business.', 'مساعد ذكي يعرف شركتك.'), cta: CTA,
    scenes: [
      { t: 'aiHook', d: 4.6, sub: T('Tekoälyavustaja, joka tuntee yrityksesi.', 'The AI assistant that knows your business.', 'مساعد ذكي يعرف شركتك.'), p: { hook: T('Tekoälyavustaja, joka *tuntee yrityksesi.*', 'The AI assistant that *knows your business.*', 'مساعد ذكي *يعرف شركتك.*') }, sfx: ['boom@0.2'] },
      { t: 'montage', d: 5.0, tr: 'cut', sub: T('Chat. CRM. Ajanvaraus. Tietopankki.', 'Chat. CRM. Booking. Knowledge base.', 'محادثة. إدارة العملاء. حجز. قاعدة معرفة.'), p: { words: [['chat', T('Chat', 'Chat', 'المحادثة')], ['users', M_CRM], ['cal', M_BOOK], ['doc', M_KB]] }, sfx: ['hit@0', 'hit@1.25', 'hit@2.5', 'hit@3.75'] },
      { t: 'ecosystem', d: 4.6, tr: 'zoom', capbg: false, cap: T('Yksi työtila, jossa kaikki toimii yhdessä.', 'One workspace where everything works together.', 'مساحة عمل واحدة يعمل فيها كل شيء معاً.') },
      { t: 'chatQA', d: 5.6, tr: 'up', concept: true, cap: T('Kysy – vastaus tulee omista tiedoistasi.', 'Ask — the answer comes from your own data.', 'اسأل — والإجابة تأتي من بياناتك أنت.'), p: { q: T('Milloin olemme auki lauantaisin?', 'When are we open on Saturdays?', 'متى نفتح أيام السبت؟'), a: T('Lauantaisin olette avoinna klo 10–15.', 'On Saturdays you are open from 10 to 15.', 'تفتحون أيام السبت من 10 إلى 15.'), src: T('Lähde: yritysprofiili', 'Source: business profile', 'المصدر: ملف الشركة'), srcIcon: 'building' }, sfx: ['pop@0.5', 'tick@3.4'] },
      { t: 'statement', d: 3.6, tr: 'fade', sub: T('Yrityksesi tiedot. Yhdessä paikassa.', "Your business's knowledge. In one place.", 'معلومات شركتك. في مكان واحد.'), p: { bg: 'blue', top: 760, text: T('Yrityksesi tiedot.\n*Yhdessä paikassa.*', "Your business's knowledge.\n*In one place.*", 'معلومات شركتك.\n*في مكان واحد.*') } },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  G02: {
    title: T('Hajallaan → yhdessä', 'Scattered → together', 'من التشتّت إلى مكان واحد'), music: 'tension', kind: 'general',
    tagline: T('Yksi työtila yrityksesi arkeen.', "One workspace for your business's everyday.", 'مساحة عمل واحدة ليوميات شركتك.'), cta: CTA,
    scenes: [
      { t: 'storm', d: 4.6, sub: T('Viestejä, varauksia, kysymyksiä. Kaikki eri paikoissa.', 'Messages, bookings, questions. All in different places.', 'رسائل، حجوزات، استفسارات. كلٌّ في مكان مختلف.'), p: { hook: T('Viestejä, varauksia, kysymyksiä.\n*Kaikki eri paikoissa.*', 'Messages, bookings, questions.\n*All in different places.*', 'رسائل، حجوزات، استفسارات.\n*كلٌّ في مكان مختلف.*') }, sfx: ['ding@0.2', 'ding@0.65', 'ding@1.1', 'ding@1.5'] },
      { t: 'scatter', d: 4.6, tr: 'fade', cap: T('Kun tieto on hajallaan, osa unohtuu.', 'When information is scattered, some of it gets forgotten.', 'حين تتشتّت المعلومات، يُنسى بعضها.') },
      { t: 'gather', d: 4.6, tr: 'zoom', cap: T('Syveka kokoaa asiakkaat, varaukset ja tiedon yhteen työtilaan.', 'Syveka brings customers, bookings and knowledge into one workspace.', 'سيفيكا تجمع عملاءك وحجوزاتك ومعلوماتك في مساحة عمل واحدة.'), sfx: ['rise@0.2', 'chime@2.2'] },
      { t: 'features', d: 5.2, tr: 'up', cap: T('Avustaja, CRM, ajanvaraus ja tietopankki samassa paikassa.', 'Assistant, CRM, booking and knowledge base in one place.', 'المساعد وإدارة العملاء والحجز وقاعدة المعرفة في مكان واحد.'), p: { items: [['ai', M_AI, T('Vastaa tiedoistasi', 'Answers from your data', 'يجيب من بياناتك')], ['users', M_CRM, T('Yhteystiedot ja kaupat', 'Contacts and deals', 'جهات الاتصال والصفقات')], ['cal', M_BOOK, T('Kalenteri ja varaussivu', 'Calendar and booking page', 'التقويم وصفحة الحجز')], ['doc', M_KB, T('Dokumentit talteen', 'Your documents', 'مستنداتك')]] }, sfx: ['pop@0.25', 'pop@0.57', 'pop@0.89', 'pop@1.21'] },
      { t: 'calm', d: 3.8, tr: 'fade', cap: T('Vähemmän etsimistä. Selkeämpi arki.', 'Less searching. A clearer day.', 'بحث أقل. ويوم أوضح.'), p: { chip: T('Kaikki yhdessä työtilassa', 'Everything in one workspace', 'كل شيء في مساحة واحدة') } },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  G03: {
    title: T('Kutsu pilottiin', 'Pilot invitation', 'دعوة للتجربة'), music: 'bright', kind: 'general',
    tagline: T('Mukaan pilottiin?', 'Want to join the pilot?', 'هل تودّ الانضمام للتجربة؟'), cta: CTA,
    scenes: [
      { t: 'setpiece', d: 4.2, sub: T('Pyöritätkö pientä yritystä Suomessa?', 'Do you run a small business in Finland?', 'هل تدير شركة صغيرة في فنلندا؟'), p: { icon: 'building', bg: 'night', hook: T('Pyöritätkö *pientä yritystä* Suomessa?', 'Do you run a *small business* in Finland?', 'هل تدير *شركة صغيرة* في فنلندا؟') } },
      { t: 'checklist', d: 5.2, tr: 'up', sub: T('Hukkuvatko asiakastiedot? Vievätkö varaukset aikaa? Toistuvatko samat kysymykset?', 'Customer details getting lost? Bookings taking your time? The same questions again and again?', 'بيانات العملاء تضيع؟ الحجوزات تأخذ وقتك؟ الأسئلة نفسها تتكرر؟'), p: { qs: [['users', T('Hukkuvatko asiakastiedot?', 'Customer details getting lost?', 'بيانات العملاء تضيع؟')], ['cal', T('Vievätkö varaukset aikaa?', 'Bookings taking your time?', 'الحجوزات تأخذ وقتك؟')], ['chat', T('Toistuvatko samat kysymykset?', 'The same questions again?', 'الأسئلة نفسها تتكرر؟')]] }, sfx: ['pop@0.4', 'pop@1.5', 'pop@2.6'] },
      { t: 'sectors', d: 5.0, tr: 'side', cap: T('Syveka on nyt maksuttomassa pilottivaiheessa.', 'Syveka is now in a free pilot phase.', 'سيفيكا الآن في مرحلة تجريبية مجانية.'), p: { kicker: T('Pilotissa mukana', 'Included in the pilot', 'ضمن التجربة'), items: [['ai', T('Tekoälyavustaja', 'AI assistant', 'المساعد الذكي')], ['users', T('CRM ja kaupat', 'CRM and deals', 'العملاء والصفقات')], ['cal', T('Kalenteri ja varaussivu', 'Calendar and booking page', 'التقويم وصفحة الحجز')], ['doc', M_KB]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05', 'tick@1.4'] },
      { t: 'steps', d: 5.0, tr: 'up', cap: T('Pilottiin otetaan rajattu määrä yrityksiä.', 'The pilot takes a limited number of businesses.', 'التجربة متاحة لعدد محدود من الشركات.'), p: { steps: [T('Kerro yrityksestäsi', 'Tell us about your business', 'أخبرنا عن شركتك'), T('Otetaan käyttöön yhdessä', 'We set it up together', 'نجهّزها معاً'), T('Kokeile omassa arjessasi', 'Try it in your daily work', 'جرّبها في عملك اليومي')] }, sfx: ['tick@0.4', 'tick@1.3', 'tick@2.2'] },
      { t: 'ctaTap', d: 3.8, tr: 'zoom', cap: T('Aloitetaan keskustelusta.', "Let's start with a conversation.", 'لنبدأ بمحادثة.'), p: { btn: CTA }, sfx: ['pop@1.7', 'chime@1.9'] },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  S01: {
    title: T('Tekoälyavustaja', 'AI assistant', 'المساعد الذكي'), music: 'future', kind: 'service',
    tagline: T('Avustaja, joka tuntee yrityksesi.', 'An assistant that knows your business.', 'مساعد يعرف شركتك.'), cta: CTA,
    scenes: [
      { t: 'aiHook', d: 4.2, sub: T('Kysy yrityksestäsi. Saat vastauksen.', 'Ask about your business. Get an answer.', 'اسأل عن شركتك. واحصل على الإجابة.'), p: { hook: T('Kysy yrityksestäsi.\n*Saat vastauksen.*', 'Ask about your business.\n*Get an answer.*', 'اسأل عن شركتك.\n*واحصل على الإجابة.*') }, sfx: ['rise@0.1'] },
      { t: 'chatQA', d: 5.6, tr: 'up', concept: true, cap: T('Vastaukset tulevat yrityksesi omista tiedoista.', "Answers come from your business's own data.", 'الإجابات تأتي من بيانات شركتك نفسها.'), p: { q: T('Mikä on peruutuskäytäntömme?', 'What is our cancellation policy?', 'ما هي سياسة الإلغاء لدينا؟'), a: T('Varauksen voi perua 24 tuntia ennen sovittua aikaa.', 'A booking can be cancelled up to 24 hours before the agreed time.', 'يمكن إلغاء الحجز قبل 24 ساعة من الموعد المحدد.'), src: T('Lähde: yritysprofiili', 'Source: business profile', 'المصدر: ملف الشركة'), srcIcon: 'building' }, sfx: ['pop@0.5', 'tick@3.4'] },
      { t: 'sectors', d: 4.8, tr: 'side', cap: T('Yksi avustaja, monta arjen tehtävää.', 'One assistant, many everyday tasks.', 'مساعد واحد لمهام يومية كثيرة.'), p: { kicker: T('Avustaja voi', 'The assistant can', 'يستطيع المساعد'), items: [['chat', T('Vastata tiedoistasi', 'Answer from your data', 'الإجابة من بياناتك')], ['users', T('Ehdottaa yhteystietoa', 'Propose a new contact', 'اقتراح جهة اتصال')], ['clock', T('Tarkistaa vapaat ajat', 'Check availability', 'التحقق من المواعيد المتاحة')], ['cal', T('Ehdottaa varausta', 'Propose a booking', 'اقتراح حجز')]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05', 'tick@1.4'] },
      { t: 'rowsCard', d: 5.2, tr: 'up', concept: true, cap: T('Avustaja ehdottaa. Mitään ei tallenneta ennen kuin vahvistat.', 'The assistant proposes. Nothing is saved until you confirm.', 'المساعد يقترح. ولا يُحفَظ شيء قبل أن تؤكّد.'), p: { bg: 'blue', icon: 'users', title: T('Ehdotus: uusi yhteystieto', 'Proposal: new contact', 'اقتراح: جهة اتصال جديدة'), tag: T('Odottaa', 'Pending', 'بانتظارك'), rows: [[T('Nimi', 'Name', 'الاسم'), T('Anna K.', 'Anna K.', 'آنا ك.')], [T('Tila', 'Status', 'الحالة'), T('Liidi', 'Lead', 'عميل محتمل')], [T('Lähde', 'Source', 'المصدر'), T('Keskustelu', 'Chat', 'المحادثة')]], btn: OK, done: T('Tallennettu', 'Saved', 'تم الحفظ') }, sfx: ['pop@2.9', 'chime@3.2'] },
      { t: 'statement', d: 3.6, tr: 'fade', sub: T('Ei arvaile. Kertoo, jos ei tiedä.', "It doesn't guess. It says when it can't confirm.", 'لا يخمّن. ويخبرك إن لم يكن متأكداً.'), p: { bg: 'blue', icon: 'ai', top: 820, text: T('Ei arvaile.\n*Kertoo, jos ei tiedä.*', "It doesn't guess.\n*It says when it can't confirm.*", 'لا يخمّن.\n*ويخبرك إن لم يكن متأكداً.*'), size: 92 } },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  S02: {
    title: M_KB, music: 'bright', kind: 'service',
    tagline: T('Yrityksesi tieto, aina löydettävissä.', "Your business's knowledge, always findable.", 'معرفة شركتك، في متناولك دائماً.'), cta: CTA,
    scenes: [
      { t: 'setpiece', d: 4.6, sub: T('Ohjeet, hinnastot, käytännöt. Kuka muistaa kaiken?', 'Guides, price lists, policies. Who remembers it all?', 'تعليمات، قوائم أسعار، سياسات. من يتذكّر كل شيء؟'), p: { icon: 'doc', bg: 'ink', hook: T('Ohjeet, hinnastot, käytännöt.\n*Kuka muistaa kaiken?*', 'Guides, price lists, policies.\n*Who remembers it all?*', 'تعليمات، قوائم أسعار، سياسات.\n*من يتذكّر كل شيء؟*') } },
      { t: 'docsIn', d: 5.4, tr: 'zoom', cap: T('Lataa dokumentit, muistiinpanot ja verkkosivut tietopankkiin.', 'Upload documents, notes and web pages to the knowledge base.', 'ارفع المستندات والملاحظات وصفحات الويب إلى قاعدة المعرفة.'), p: { items: [['doc', 'PDF'], ['doc', 'DOCX'], ['link', T('Verkkosivu', 'Web page', 'صفحة ويب')], ['note', T('Muistiinpanot', 'Notes', 'ملاحظات')]] }, sfx: ['rise@1.4', 'chime@2.9'] },
      { t: 'chatQA', d: 5.8, tr: 'up', concept: true, cap: T('Avustaja vastaa niiden pohjalta – ja näyttää lähteen.', 'The assistant answers from them — and shows the source.', 'المساعد يجيب اعتماداً عليها — ويعرض المصدر.'), p: { q: T('Miten uusi asiakas otetaan vastaan?', 'How do we onboard a new customer?', 'كيف نستقبل عميلاً جديداً؟'), a: T('Ohjeen mukaan: tervetuloviesti, tietojen kirjaus ja ensimmäisen ajan varaus.', 'Per the guide: a welcome message, recording the details and booking the first appointment.', 'بحسب الدليل: رسالة ترحيب، ثم تسجيل البيانات، ثم حجز الموعد الأول.'), src: T('Lähde: perehdytysohje.pdf', 'Source: onboarding-guide.pdf', 'المصدر: دليل-الاستقبال.pdf') }, sfx: ['pop@0.5', 'tick@3.4'] },
      { t: 'statement', d: 4.0, tr: 'fade', sub: T('Tieto löytyy. Lähteineen.', 'The answer is there. With its source.', 'المعلومة موجودة. ومعها مصدرها.'), p: { bg: 'ink', icon: 'doc', top: 820, text: T('Tieto löytyy.\n*Lähteineen.*', 'The answer is there.\n*With its source.*', 'المعلومة موجودة.\n*ومعها مصدرها.*') } },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  S03: {
    title: T('Yritysprofiili', 'Business profile', 'ملف الشركة'), music: 'warm', kind: 'service',
    tagline: T('Profiili, jonka avustajasi tuntee.', 'A profile your assistant knows by heart.', 'ملف يعرفه مساعدك جيداً.'), cta: CTA,
    scenes: [
      { t: 'setpiece', d: 4.2, sub: T('Kerro yrityksestäsi kerran.', 'Tell it about your business once.', 'عرّف بشركتك مرة واحدة.'), p: { icon: 'building', bg: 'steel', hook: T('Kerro yrityksestäsi\n*kerran.*', 'Tell it about your business\n*once.*', 'عرّف بشركتك\n*مرة واحدة.*') } },
      { t: 'form', d: 5.4, tr: 'up', concept: true, cap: T('Palvelut, aukioloajat ja käytännöt yhteen profiiliin.', 'Services, opening hours and policies in one profile.', 'الخدمات وساعات العمل والسياسات في ملف واحد.'), p: { icon: 'building', title: T('Yritysprofiili', 'Business profile', 'ملف الشركة'), fields: [[T('Palvelut', 'Services', 'الخدمات'), T('Hiustenleikkaus, värjäys', 'Haircut, colouring', 'قصّ الشعر، الصبغ')], [T('Aukioloajat', 'Opening hours', 'ساعات العمل'), T('Ma–Pe 9–17', 'Mon–Fri 9–17', 'الإثنين–الجمعة 9–17')], [T('Käytännöt', 'Policies', 'السياسات'), T('Peruutus 24 h ennen', 'Cancel 24 h before', 'الإلغاء قبل 24 ساعة')]], btn: T('Tallenna', 'Save', 'حفظ') }, sfx: ['type@0.6', 'type@1.5', 'type@2.4', 'pop@3.5'] },
      { t: 'chatQA', d: 5.4, tr: 'zoom', concept: true, cap: T('Avustaja käyttää profiilia vastauksissaan.', 'The assistant uses the profile in its answers.', 'المساعد يعتمد على الملف في إجاباته.'), p: { q: T('Milloin olemme auki?', 'When are we open?', 'متى نفتح؟'), a: T('Olette avoinna maanantaista perjantaihin klo 9–17.', 'You are open Monday to Friday, 9 to 17.', 'تفتحون من الإثنين إلى الجمعة، من 9 إلى 17.'), src: T('Lähde: yritysprofiili', 'Source: business profile', 'المصدر: ملف الشركة'), srcIcon: 'building' }, sfx: ['pop@0.5', 'tick@3.4'] },
      { t: 'rowsCard', d: 5.2, tr: 'up', concept: true, cap: T('Muutokset tehdään vasta, kun hyväksyt ne.', 'Changes are made only when you approve them.', 'لا تُنفَّذ التغييرات إلا بعد موافقتك.'), p: { icon: 'clock', title: T('Ehdotus: päivitä aukioloajat', 'Proposal: update opening hours', 'اقتراح: تحديث ساعات العمل'), tag: T('Odottaa', 'Pending', 'بانتظارك'), rows: [[T('Lauantai', 'Saturday', 'السبت'), '10–14'], [T('Sunnuntai', 'Sunday', 'الأحد'), T('Suljettu', 'Closed', 'مغلق')]], btn: OK, done: T('Päivitetty', 'Updated', 'تم التحديث') }, sfx: ['pop@2.9', 'chime@3.2'] },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  S04: {
    title: T('CRM: yhteystiedot', 'CRM: contacts', 'إدارة العملاء: جهات الاتصال'), music: 'bright', kind: 'service',
    tagline: T('Asiakkaasi järjestyksessä.', 'Your customers, in order.', 'عملاؤك في نظام.'), cta: CTA,
    scenes: [
      { t: 'setpiece', d: 4.4, sub: T('Asiakastiedot lapuilla, sähköpostissa ja päässä?', 'Customer details on notes, in email and in your head?', 'بيانات العملاء على أوراق، وفي البريد، وفي الذاكرة؟'), p: { icon: 'users', bg: 'fresh', hook: T('Asiakastiedot lapuilla, sähköpostissa ja *päässä?*', 'Customer details on notes, in email and *in your head?*', 'بيانات العملاء على أوراق، وفي البريد، *وفي الذاكرة؟*') } },
      { t: 'contacts', d: 5.6, tr: 'side', concept: true, cap: T('Kaikki yhteystiedot yhdessä listassa – haku löytää heti.', 'All contacts in one list — search finds them instantly.', 'كل جهات الاتصال في قائمة واحدة — والبحث يجدها فوراً.'), p: { title: T('Yhteystiedot', 'Contacts', 'جهات الاتصال'), search: T('Anna', 'Anna', 'آنا'), keep: 0, rows: [['AK', T('Anna K.', 'Anna K.', 'آنا ك.'), T('Yksityisasiakas', 'Private customer', 'عميل فردي'), T('Asiakas', 'Customer', 'عميل'), 1], ['ML', T('Mikko L.', 'Mikko L.', 'ميكو ل.'), T('Yritysasiakas', 'Business customer', 'عميل شركة'), T('Liidi', 'Lead', 'محتمل'), 0], ['SH', T('Sara H.', 'Sara H.', 'سارة هـ.'), T('Yksityisasiakas', 'Private customer', 'عميل فردي'), T('Asiakas', 'Customer', 'عميل'), 1], ['JV', T('Jari V.', 'Jari V.', 'ياري ف.'), T('Yritysasiakas', 'Business customer', 'عميل شركة'), T('Liidi', 'Lead', 'محتمل'), 0]] }, sfx: ['type@2.4'] },
      { t: 'rowsCard', d: 5.0, tr: 'up', concept: true, cap: T('Muistiinpanot ja historia samassa näkymässä.', 'Notes and history in the same view.', 'الملاحظات والسجلّ في العرض نفسه.'), p: { icon: 'user', title: T('Anna K.', 'Anna K.', 'آنا ك.'), sub: T('Yksityisasiakas', 'Private customer', 'عميل فردي'), tag: T('Asiakas', 'Customer', 'عميل'), tagCls: 'g', rows: [[T('Viimeisin', 'Latest', 'آخر نشاط'), T('Puhelu, sovittu aika', 'Call, time agreed', 'مكالمة، تم تحديد موعد')], [T('Muistiinpano', 'Note', 'ملاحظة'), T('Toivoo iltapäiviä', 'Prefers afternoons', 'يفضّل فترة بعد الظهر')], [T('Seuraava', 'Next', 'التالي'), T('Tapaaminen torstaina', 'Meeting on Thursday', 'لقاء يوم الخميس')]] }, sfx: ['tick@0.6', 'tick@0.85', 'tick@1.1'] },
      { t: 'statement', d: 3.8, tr: 'fade', sub: T('Tiedät heti, kuka on kuka.', "You know at a glance who's who.", 'تعرف فوراً من هو من.'), p: { bg: 'fresh', icon: 'users', top: 820, text: T('Tiedät heti,\n*kuka on kuka.*', "You know at a glance\n*who's who.*", 'تعرف فوراً\n*من هو من.*') } },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  S05: {
    title: T('Myyntiputki', 'Deals pipeline', 'مسار الصفقات'), music: 'drive', kind: 'service',
    tagline: T('Myyntiputki selkeästi näkyvissä.', 'Your sales pipeline, clearly in view.', 'مسار مبيعاتك واضح أمامك.'), cta: CTA,
    scenes: [
      { t: 'setpiece', d: 4.2, sub: T('Missä vaiheessa kauppasi ovat?', 'What stage are your deals at?', 'في أي مرحلة صفقاتك؟'), p: { icon: 'funnel', bg: 'ink', hook: T('Missä vaiheessa *kauppasi* ovat?', 'What stage are *your deals* at?', 'في أي مرحلة *صفقاتك؟*') } },
      { t: 'pipeline', d: 5.6, tr: 'up', concept: true, cap: T('Seuraa kauppoja vaihe vaiheelta.', 'Track deals stage by stage.', 'تابع صفقاتك مرحلة بمرحلة.'), p: { cols: [T('Uusi', 'New', 'جديد'), T('Tarjous', 'Quote', 'عرض سعر'), T('Sovittu', 'Agreed', 'متَّفق عليه')], cards: [[T('Kauppa A', 'Deal A', 'الصفقة أ'), T('Yhteydenotto', 'First contact', 'تواصل أول'), 0, 0, null], [T('Kauppa B', 'Deal B', 'الصفقة ب'), T('Tarjouspyyntö', 'Quote requested', 'طلب عرض سعر'), 0, 1, [1, 1.7, 1]], [T('Kauppa C', 'Deal C', 'الصفقة ج'), T('Tarjous lähetetty', 'Quote sent', 'أُرسل العرض'), 1, 0, [2, 2.8, 1]], [T('Kauppa D', 'Deal D', 'الصفقة د'), T('Sovittu', 'Agreed', 'متَّفق عليه'), 2, 0, null], [T('Kauppa E', 'Deal E', 'الصفقة هـ'), T('Uusi liidi', 'New lead', 'عميل محتمل جديد'), 0, 2, null]] }, sfx: ['tick@1.7', 'tick@2.8'] },
      { t: 'rowsCard', d: 5.0, tr: 'side', concept: true, cap: T('Jokaisella kaupalla on vaihe ja seuraava askel.', 'Every deal has a stage and a next step.', 'لكل صفقة مرحلة وخطوة تالية.'), p: { icon: 'funnel', title: T('Kauppa B', 'Deal B', 'الصفقة ب'), tag: T('Tarjous', 'Quote', 'عرض سعر'), tagCls: 'b', rows: [[T('Yhteyshenkilö', 'Contact', 'جهة الاتصال'), T('Mikko L.', 'Mikko L.', 'ميكو ل.')], [T('Viimeisin', 'Latest', 'آخر نشاط'), T('Tarjous lähetetty', 'Quote sent', 'أُرسل العرض')], [T('Seuraava askel', 'Next step', 'الخطوة التالية'), T('Soitto perjantaina', 'Call on Friday', 'اتصال يوم الجمعة')]] }, sfx: ['tick@0.6', 'tick@0.85', 'tick@1.1'] },
      { t: 'statement', d: 3.8, tr: 'zoom', sub: T('Näet tilanteen yhdellä silmäyksellä.', 'See where things stand at a glance.', 'ترى الوضع بنظرة واحدة.'), p: { bg: 'steel', icon: 'funnel', top: 820, text: T('Näet tilanteen\n*yhdellä silmäyksellä.*', 'See where things stand\n*at a glance.*', 'ترى الوضع\n*بنظرة واحدة.*') } },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  S06: {
    title: T('Kalenteri', 'Calendar', 'التقويم'), music: 'warm', kind: 'service',
    tagline: T('Kalenteri, joka pysyy mukana.', 'A calendar that keeps up with you.', 'تقويم يواكب يومك.'), cta: CTA,
    scenes: [
      { t: 'calendar', d: 4.6, sub: T('Viikko täynnä. Mahtuuko vielä yksi?', 'A full week. Room for one more?', 'أسبوع ممتلئ. هل من متّسع لموعد آخر؟'), p: { hook: T('Viikko täynnä.\n*Mahtuuko vielä yksi?*', 'A full week.\n*Room for one more?*', 'أسبوع ممتلئ.\n*هل من متّسع لموعد آخر؟*') }, sfx: ['tick@1.4'] },
      { t: 'weekView', d: 5.6, tr: 'up', concept: true, cap: T('Päivä-, viikko- ja kuukausinäkymä samassa kalenterissa.', 'Day, week and month views in one calendar.', 'عرض اليوم والأسبوع والشهر في تقويم واحد.'), p: { title: T('Viikko', 'Week', 'الأسبوع'), days: [T('Ma', 'Mon', 'الإثنين'), T('Ti', 'Tue', 'الثلاثاء'), T('Ke', 'Wed', 'الأربعاء'), T('To', 'Thu', 'الخميس'), T('Pe', 'Fri', 'الجمعة')], events: [[0, 30, 130, T('Tapaaminen', 'Meeting', 'اجتماع'), 1], [1, 190, 110, T('Varaus', 'Booking', 'حجز'), 1], [2, 60, 170, T('Varaus', 'Booking', 'حجز'), 1], [2, 420, 110, T('Tauko', 'Break', 'استراحة'), 0], [3, 260, 150, T('Varaus', 'Booking', 'حجز'), 1], [4, 40, 110, T('Tapaaminen', 'Meeting', 'اجتماع'), 1], [0, 380, 130, T('Varaus', 'Booking', 'حجز'), 1]] }, sfx: ['pop@0.7', 'pop@1.0', 'pop@1.3', 'pop@1.6', 'pop@1.9'] },
      { t: 'rowsCard', d: 5.0, tr: 'side', concept: true, cap: T('Määritä, milloin sinut voi varata.', 'Set when you can be booked.', 'حدّد الأوقات التي يمكن حجزك فيها.'), p: { icon: 'clock', title: T('Saatavuus', 'Availability', 'أوقات التوفّر'), tag: T('Käytössä', 'Active', 'مفعّل'), tagCls: 'g', rows: [[T('Ma–To', 'Mon–Thu', 'الإثنين–الخميس'), '9–17'], [T('Perjantai', 'Friday', 'الجمعة'), '9–15'], [T('La–Su', 'Sat–Sun', 'السبت–الأحد'), T('Ei varattavissa', 'Not bookable', 'غير متاح')]] }, sfx: ['tick@0.6', 'tick@0.85', 'tick@1.1'] },
      { t: 'statement', d: 3.8, tr: 'fade', sub: T('Kalenteri ja varaukset samassa paikassa.', 'Calendar and bookings in the same place.', 'التقويم والحجوزات في مكان واحد.'), p: { bg: 'blue', icon: 'cal', top: 820, text: T('Kalenteri ja varaukset\n*samassa paikassa.*', 'Calendar and bookings\n*in the same place.*', 'التقويم والحجوزات\n*في مكان واحد.*'), size: 92 } },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  S07: {
    title: T('Varaussivu', 'Booking page', 'صفحة الحجز'), music: 'drive', kind: 'service',
    tagline: T('Oma varaussivu yrityksellesi.', 'Your own booking page.', 'صفحة حجز خاصة بشركتك.'), cta: CTA,
    scenes: [
      { t: 'setpiece', d: 4.0, sub: T('Varaukset ilman puhelinrallia.', 'Bookings without the phone tag.', 'حجوزات بلا مكالمات متبادلة.'), p: { icon: 'link', bg: 'night', hook: T('Varaukset ilman\n*puhelinrallia.*', 'Bookings without\n*the phone tag.*', 'حجوزات بلا\n*مكالمات متبادلة.*') } },
      { t: 'phoneTag', d: 4.4, tr: 'side', cap: T('Soittoja ja viestejä edestakaisin – yhden ajan takia.', 'Calls and messages back and forth — for a single appointment.', 'مكالمات ورسائل ذهاباً وإياباً — من أجل موعد واحد.'), sfx: ['ring@0.3', 'ring@1.5', 'ring@2.7'] },
      { t: 'linkShare', d: 4.8, tr: 'zoom', cap: T('Jaa oma varauslinkkisi asiakkaille.', 'Share your own booking link with customers.', 'شارك رابط الحجز الخاص بك مع عملائك.'), p: { url: '…/book/yritys/palvelu', copy: T('Kopioi', 'Copy', 'نسخ'), copied: T('Kopioitu', 'Copied', 'تم النسخ'), to: [['chat', T('Viesti', 'Message', 'رسالة')], ['mail', T('Sähköposti', 'Email', 'بريد')], ['web', T('Verkkosivu', 'Website', 'موقعك')]] }, sfx: ['pop@1.5', 'tick@2.3', 'tick@2.55', 'tick@2.8'] },
      { t: 'booking', d: 5.0, tr: 'side', concept: true, cap: T('Asiakas valitsee itse sopivan ajan.', 'Customers pick a time that suits them.', 'العميل يختار الوقت المناسب بنفسه.'), p: { bg: 'night' }, sfx: ['pop@1.6', 'pop@2.9', 'chime@3.3'] },
      { t: 'quiet', d: 4.4, tr: 'fade', cap: T('Varaus näkyy kalenterissasi – ja asiakas voi siirtää tai perua sen linkistä.', 'The booking appears in your calendar — and the customer can reschedule or cancel from a link.', 'يظهر الحجز في تقويمك — ويستطيع العميل تغييره أو إلغاءه عبر رابط.'), p: { bg: 'night', icon: 'cal', text: T('Uusi varaus', 'New booking', 'حجز جديد'), sub: T('Torstai 14:30', 'Thursday 14:30', 'الخميس 14:30') }, sfx: ['ding@1.2'] },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  S08: {
    title: T('Tiimi ja roolit', 'Team and roles', 'الفريق والصلاحيات'), music: 'luxe', kind: 'service',
    tagline: T('Tiimille, joka tekee töitä yhdessä.', 'For a team that works together.', 'لفريق يعمل معاً.'), cta: CTA,
    scenes: [
      { t: 'setpiece', d: 4.2, sub: T('Kuka näkee mitä?', 'Who sees what?', 'من يرى ماذا؟'), p: { icon: 'users', bg: 'steel', hook: T('Kuka näkee\n*mitä?*', 'Who sees\n*what?*', 'من يرى\n*ماذا؟*'), } },
      { t: 'sectors', d: 5.6, tr: 'up', cap: T('Kutsu tiimisi mukaan ja anna jokaiselle sopiva rooli.', 'Invite your team and give everyone the right role.', 'ادعُ فريقك وامنح كل عضو الدور المناسب.'), p: { kicker: T('Roolit', 'Roles', 'الأدوار'), items: [['shield', T('Omistaja', 'Owner', 'المالك')], ['gear', T('Ylläpitäjä', 'Admin', 'المشرف')], ['list', T('Esihenkilö', 'Manager', 'المدير')], ['user', T('Jäsen', 'Member', 'عضو')], ['search', T('Katselija', 'Viewer', 'مشاهد')]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05', 'tick@1.4', 'tick@1.75'] },
      { t: 'rowsCard', d: 5.0, tr: 'side', concept: true, cap: T('Tärkeät toiminnot kirjautuvat lokiin.', 'Important actions are recorded in a log.', 'الإجراءات المهمة تُسجَّل في سجلّ.'), p: { icon: 'list', title: T('Tapahtumaloki', 'Audit log', 'سجلّ الأحداث'), tag: T('Kirjattu', 'Recorded', 'مسجَّل'), tagCls: 'g', rows: [[T('Yhteystieto luotu', 'Contact created', 'إنشاء جهة اتصال'), T('Anna K.', 'Anna K.', 'آنا ك.')], [T('Rooli muutettu', 'Role changed', 'تغيير دور'), T('Jäsen → Esihenkilö', 'Member → Manager', 'عضو ← مدير')], [T('Varaus siirretty', 'Booking moved', 'نقل حجز'), T('To 14:30', 'Thu 14:30', 'الخميس 14:30')]] }, sfx: ['tick@0.6', 'tick@0.85', 'tick@1.1'] },
      { t: 'statement', d: 4.0, tr: 'fade', sub: T('Jokaisen yrityksen tiedot pysyvät erillään.', "Each organisation's data is kept separate.", 'بيانات كل شركة تبقى منفصلة.'), p: { bg: 'ink', icon: 'shield', top: 820, text: T('Jokaisen yrityksen tiedot\n*pysyvät erillään.*', "Each organisation's data\n*is kept separate.*", 'بيانات كل شركة\n*تبقى منفصلة.*'), size: 86 } },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  S09: {
    title: T('Kolme kieltä', 'Three languages', 'ثلاث لغات'), music: 'future', kind: 'service',
    tagline: T('Suomeksi, englanniksi ja arabiaksi.', 'In Finnish, English and Arabic.', 'بالفنلندية والإنجليزية والعربية.'), cta: CTA,
    scenes: [
      { t: 'montage', d: 5.0, sub: T('Suomeksi. Englanniksi. Arabiaksi.', 'Finnish. English. Arabic.', 'بالفنلندية. بالإنجليزية. بالعربية.'), p: { words: [['globe', 'Suomi'], ['globe', 'English'], ['globe', 'العربية'], ['globe', 'FI · EN · AR']] }, sfx: ['hit@0', 'hit@1.25', 'hit@2.5', 'hit@3.75'] },
      { t: 'triLang', d: 6.0, tr: 'zoom', concept: true, cap: T('Sama työtila kolmella kielellä.', 'The same workspace in three languages.', 'مساحة العمل نفسها بثلاث لغات.'), p: { q: T('Milloin olette auki?', 'When are you open?', 'متى تفتحون؟'), a: T('Arkisin klo 9–17.', 'Weekdays from 9 to 17.', 'أيام الأسبوع من 9 إلى 17.') }, sfx: ['pop@0.3', 'pop@1.1', 'pop@1.9'] },
      { t: 'statement', d: 4.2, tr: 'fade', sub: T('Arabia toimii oikealta vasemmalle – kuten kuuluu.', 'Arabic runs right to left — as it should.', 'العربية من اليمين إلى اليسار — كما ينبغي.'), p: { bg: 'blue', icon: 'globe', top: 820, text: T('Arabia toimii oikealta vasemmalle –\n*kuten kuuluu.*', 'Arabic runs right to left —\n*as it should.*', 'العربية من اليمين إلى اليسار —\n*كما ينبغي.*'), size: 84 } },
      { t: 'ctaTap', d: 4.0, tr: 'zoom', cap: T('Käytä Syvekaa omalla kielelläsi.', 'Use Syveka in your own language.', 'استخدم سيفيكا بلغتك.'), p: { btn: CTA }, sfx: ['pop@1.7', 'chime@1.9'] },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
};
