/* ============================================================
   activities.js - Practice Paths, five optional levels,
   condition-specific activities and the activity runner.

   Honesty rules baked in here:
   * Self-practice vs clinician-configured activities are
     clearly separated (dysarthria / apraxia / ABI activities
     only unlock from a configuration a clinician provided).
   * Difficulty suggestions come from comfort ratings, goals and
     feedback ONLY - never from how fluent speech sounds.
   * Nothing here is presented as treatment or as clinically
     validated. Users can jump or skip levels freely.
   ============================================================ */

import {
  $, el, clear, openModal, closeModal, toast, emit, explainDetails, appendMarkedTranscript,
  showConsentModal,
} from "./ui.js";
import {
  getProfile, getLevels, setLevel, getClinician, saveClinician,
  clearClinician, logSession, getSessions, hasConsent,
} from "./storage.js";
import { needLabel } from "./profile.js";
import { detectEvents } from "./detect.js";
import { createUtteranceRecorder, richerTranscript, speakSoft, transcribeBlob } from "./speech.js";
import { openPracticeAgent } from "./practiceagent.js";
import { pictureVisual } from "./pictures.js";

/* ------------------------------------------------------------------
   Levels (optional, user-controlled)
------------------------------------------------------------------ */
export const LEVELS = [
  { id: 1, name: "Familiar words", blurb: "Single everyday words" },
  { id: 2, name: "Short sentences", blurb: "One simple sentence at a time" },
  { id: 3, name: "Everyday conversations", blurb: "Chat about daily life" },
  { id: 4, name: "Social situations", blurb: "Greetings, calls, small talk" },
  { id: 5, name: "Real-world scenarios", blurb: "Longer, unscripted moments" },
];

export function levelInfo(id) {
  return LEVELS.find((l) => l.id === id) || LEVELS[0];
}

const ALL_LEVELS = [1, 2, 3, 4, 5];

/* ------------------------------------------------------------------
   Activity content library
------------------------------------------------------------------ */

/* ---- Shared prompt pools ---- */
const CONVERSATION_PROMPTS = {
  1: [
    "Say five everyday words out loud, one at a time: water, morning, music, family, ready.",
    "Name three things you can see around you right now.",
    "Say one word for how you feel today.",
  ],
  2: [
    "Say: “Today I am going to…” and finish the sentence.",
    "Tell me in one short sentence what you had for your last meal.",
    "Describe your day so far in one sentence.",
  ],
  3: [
    "Tell me about a normal weekday morning for you.",
    "What do you like to do after work or school? Say a little about it.",
    "Describe your favourite place to relax.",
  ],
  4: [
    "Practise greeting someone: “Hi, nice to meet you — how has your day been?”",
    "You're at a shop and you want to buy some milk. Say what you would say.",
    "Practise politely asking someone to repeat: “Sorry, could you say that again?”",
  ],
  5: [
    "Phone scenario: call a clinic to move an appointment. Say what you would say.",
    "Friends ask what you've been up to. Answer in a few sentences.",
    "Explain a problem you had this week to a friend, from start to finish.",
  ],
};

const READING_PASSAGES = {
  1: [
    "Read these words out loud: cat, sun, book, tree, fish, door.",
    "Read aloud: red, blue, green, yellow, orange.",
  ],
  2: [
    "Read aloud: “The cat sat on the warm mat.”",
    "Read aloud: “We are going to the park after lunch.”",
  ],
  3: [
    "Read this short paragraph aloud, at your own pace:\n\n“Every morning I open the curtains and let the light in. I make a cup of tea and plan my day. Small routines like this help me feel settled.”",
  ],
  4: [
    "Read this social script aloud:\n\n“Hello! Good to see you. How have you been? … That's great to hear. What have you been up to lately?”",
  ],
  5: [
    "Read this longer passage aloud, pausing wherever you need:\n\n“Last weekend we drove out of town early, before the roads got busy. The air was cool and the fields were still wet with dew. We stopped at a little café halfway there, drank strong coffee, and watched the world wake up. By the time we arrived, the sun was high and the whole day felt like a gift.”",
  ],
};

const ROLEPLAY_SCENARIOS = {
  1: [
    "Say “hello” and “thank you” to someone in your room, out loud.",
    "Practise saying “yes” and “no” clearly, once each.",
  ],
  2: [
    "Introduce yourself in one sentence: “Hi, I'm [your name] and I like…”",
    "Ask a simple question out loud: “What time is it?”",
  ],
  3: [
    "Role-play: a friend asks how your week went. Answer with two or three sentences.",
    "Role-play: you need to ask someone for directions to a nearby shop.",
  ],
  4: [
    "Role-play: you're at a party and you start a conversation with someone new.",
    "Role-play: you're returning something at a store and explaining the problem.",
  ],
  5: [
    "Role-play: a job or school interview — answer “Tell me about yourself.”",
    "Role-play: you disagree politely with someone about plans for the weekend.",
  ],
};

/* ---- The paths ---- */
export const PATHS = {
  stuttering: {
    id: "stuttering",
    title: "Stuttering support practice",
    blurb:
      "Supportive conversation practice plus optional awareness activities. These are self-practice exercises for comfort and reflection — not treatment, and not a diagnosis.",
    clinicianGated: false,
    activities: [
      {
        id: "stut-convo",
        title: "Supportive conversation",
        type: "prompt",
        kind: "self",
        ages: ["adult"],
        intro:
          "Talk about these prompts out loud. Go at whatever pace feels comfortable — there is no score and no time limit.",
        content: CONVERSATION_PROMPTS,
        levels: ALL_LEVELS,
      },
      {
        id: "stut-awareness",
        title: "Optional awareness moments",
        type: "prompt",
        kind: "self",
        optional: true,
        ages: ["adult"],
        intro:
          "An optional reflection activity: simply notice how speaking felt today. No judgement, no measuring — awareness only.",
        content: {
          1: [
            "After you finish talking, note: did any words feel easy today?",
            "Say a few words, then notice: did anything feel tense? Just notice it.",
          ],
          2: [
            "Notice one moment that felt easy and one that felt harder. Write or say them.",
            "After a sentence, ask yourself: “Where did I feel loose?”",
          ],
          3: [
            "During a short conversation, notice where you felt easy and where you felt effort. No judgement — just noticing.",
            "Reflect: which situations feel easier to speak in, and which feel harder?",
          ],
          4: [
            "After a social exchange, note: what helped you feel more at ease?",
            "Notice: did starting a conversation feel different from continuing one?",
          ],
          5: [
            "After a longer speaking moment, write down what you noticed — ease, effort, or anything else.",
            "Reflect on the week: which moments felt most comfortable, and why do you think that was?",
          ],
        },
        levels: ALL_LEVELS,
      },
      {
        id: "stut-child-play",
        title: "Slow play-word practice",
        type: "prompt",
        kind: "self",
        ages: ["child"],
        caregiverNote: "Caregiver: play along, pause between words, and keep it light. This is practice, not a test.",
        intro: "Say the words out loud with a caregiver, one at a time, with a little pause between each. There is no score.",
        content: {
          1: [
            "With a caregiver, say these play words one at a time: ball, duck, star, train, milk.",
            "Name three toys you can see, slowly, one word at a time.",
            "Say a favourite animal, clap once, then say the animal again.",
          ],
          2: [
            "Finish this out loud: “I like to play with…”",
            "Tell a caregiver one thing you did today, in one short sentence.",
            "Look at a picture-book page and say one sentence about it.",
          ],
          3: [
            "Tell a caregiver about a game you played, using two or three short sentences.",
            "Practise asking: “Can we play together?” then wait for the answer.",
            "Describe your favourite snack in a few easy words.",
          ],
          4: [
            "Practise greeting a friend: “Hi! Do you want to play?”",
            "Role-play with a caregiver: you are ordering a pretend ice cream.",
            "Ask a caregiver their favourite colour, then say yours.",
          ],
          5: [
            "Tell a short story about a dragon and a kite, taking your time.",
            "Explain to a caregiver how to play your favourite playground game.",
            "Talk about a birthday: who was there and what you did.",
          ],
        },
        levels: ALL_LEVELS,
      },
      {
        id: "stut-teen-talk",
        title: "School and friends practice",
        type: "prompt",
        kind: "self",
        ages: ["teenager"],
        intro: "Say these out loud at your own pace. They are everyday teen situations — not a test, and not a score.",
        content: {
          1: [
            "Say these school words out loud, one at a time: locker, homework, playlist, practice, weekend.",
            "Name three things in your bag.",
            "Say one word for how today at school felt.",
          ],
          2: [
            "Finish this: “After school I usually…”",
            "In one sentence, say what class you have next.",
            "Tell a friend, in one sentence, what you want for lunch.",
          ],
          3: [
            "Describe a normal school morning from waking up to first class.",
            "Talk about a hobby you do with friends — a sport, a game, or music.",
            "Explain a group project in a few sentences, as if a classmate missed it.",
          ],
          4: [
            "Practise joining a conversation: “Hey, what are you all doing after class?”",
            "Say out loud how you would invite someone to study together.",
            "Practise asking a teacher: “Could you explain that part again?”",
          ],
          5: [
            "Answer “What did you do this weekend?” in a few sentences, as if a friend asked.",
            "Practise a short class-presentation opening: name the topic and one main point.",
            "A friend wants to change plans. Say how you would suggest a different time.",
          ],
        },
        levels: ALL_LEVELS,
      },
    ],
  },

  aphasia: {
    id: "aphasia",
    title: "Word-finding & sentence practice",
    blurb:
      "Picture naming, word association and sentence construction for practising word retrieval. Self-practice only — it does not replace therapy.",
    clinicianGated: false,
    activities: [
      {
        id: "aph-picture",
        title: "Picture naming",
        type: "picture",
        kind: "self",
        mode: "naming",
        ages: ["adult"],
        intro: "Say the name of the picture out loud first. Reveal the word only if you want a hint.",
        content: {
          1: [
            { emoji: "🍎", word: "apple" }, { emoji: "🐱", word: "cat" },
            { emoji: "🔑", word: "key" }, { emoji: "🚗", word: "car" },
            { emoji: "🏠", word: "house" }, { emoji: "☀️", word: "sun" },
          ],
          2: [
            { emoji: "🍌", word: "banana" }, { emoji: "📚", word: "book" },
            { emoji: "🚪", word: "door" }, { emoji: "👟", word: "shoe" },
            { emoji: "🌧️", word: "rain" }, { emoji: "🐟", word: "fish" },
          ],
          3: [
            { emoji: "🚌", word: "bus" }, { emoji: "🧀", word: "cheese" },
            { emoji: "🪟", word: "window" }, { emoji: "✈️", word: "plane" },
            { emoji: "🌳", word: "tree" }, { emoji: "🥄", word: "spoon" },
          ],
          4: [
            { emoji: "🍳", word: "breakfast" }, { emoji: "🧦", word: "sock" },
            { emoji: "🛒", word: "shopping cart" }, { emoji: "🏥", word: "clinic" },
            { emoji: "🎸", word: "guitar" }, { emoji: "🌉", word: "bridge" },
          ],
          5: [
            { emoji: "🌅", word: "sunrise" }, { emoji: "🧩", word: "puzzle" },
            { emoji: "🎉", word: "celebration" }, { emoji: "📦", word: "package" },
            { emoji: "🧭", word: "compass" }, { emoji: "🪴", word: "houseplant" },
          ],
        },
        levels: ALL_LEVELS,
      },
      {
        id: "aph-associate",
        title: "Word association",
        type: "words",
        kind: "self",
        mode: "associate",
        ages: ["adult"],
        intro: "Say as many words as you can that connect to the prompt. Any answer is a good answer.",
        content: {
          1: { prompt: "water", ideas: ["drink", "ocean", "river", "blue", "thirsty"] },
          2: { prompt: "happy", ideas: ["smile", "friend", "sunny", "laugh", "good"] },
          3: { prompt: "travel", ideas: ["plane", "hotel", "map", "trip", "suitcase"] },
          4: { prompt: "doctor", ideas: ["clinic", "appointment", "waiting", "medicine", "check-up"] },
          5: { prompt: "change", ideas: ["new", "move", "adapt", "different", "grow"] },
        },
        levels: ALL_LEVELS,
      },
      {
        id: "aph-sentence",
        title: "Sentence construction",
        type: "words",
        kind: "self",
        mode: "build",
        ages: ["adult"],
        intro: "Tap the words in order to build a sentence, then check it. Say the finished sentence out loud too.",
        content: {
          1: { words: ["I", "like", "cats."], target: "I like cats." },
          2: { words: ["The", "sun", "is", "warm."], target: "The sun is warm." },
          3: { words: ["I", "am", "going", "to", "the", "shop."], target: "I am going to the shop." },
          4: { words: ["Could", "you", "please", "help", "me", "with", "this?"], target: "Could you please help me with this?" },
          5: { words: ["Yesterday", "I", "went", "to", "the", "market", "and", "bought", "vegetables."], target: "Yesterday I went to the market and bought vegetables." },
        },
        levels: ALL_LEVELS,
      },
      {
        id: "aph-child-naming",
        title: "Toy and animal naming",
        type: "picture",
        kind: "self",
        mode: "naming",
        ages: ["child"],
        caregiverNote: "Caregiver: let the child say the word first. Show the hint only if they ask.",
        intro: "Say the name of each picture out loud. A caregiver can play along.",
        content: {
          1: [
            { emoji: "🧸", word: "bear" }, { emoji: "🦆", word: "duck" },
            { emoji: "⚽", word: "ball" }, { emoji: "🥛", word: "milk" },
            { emoji: "⭐", word: "star" }, { emoji: "🚂", word: "train" },
          ],
          2: [
            { emoji: "🐸", word: "frog" }, { emoji: "🎂", word: "cake" },
            { emoji: "🚤", word: "boat" }, { emoji: "🌙", word: "moon" },
            { emoji: "🥁", word: "drum" }, { emoji: "🪁", word: "kite" },
          ],
          3: [
            { emoji: "🖍️", word: "crayon" }, { emoji: "🐰", word: "rabbit" },
            { emoji: "🚲", word: "bicycle" }, { emoji: "🌈", word: "rainbow" },
            { emoji: "🍪", word: "cookie" }, { emoji: "🐘", word: "elephant" },
          ],
          4: [
            { emoji: "🏰", word: "castle" }, { emoji: "🧩", word: "jigsaw" },
            { emoji: "🌻", word: "garden" }, { emoji: "🪜", word: "ladder" },
            { emoji: "🐧", word: "penguin" }, { emoji: "🎈", word: "balloon" },
          ],
          5: [
            { emoji: "🎁", word: "present" }, { emoji: "🦋", word: "butterfly" },
            { emoji: "☂️", word: "umbrella" }, { emoji: "⛄", word: "snowman" },
            { emoji: "🦕", word: "dinosaur" }, { emoji: "🎠", word: "carousel" },
          ],
        },
        levels: ALL_LEVELS,
      },
      {
        id: "aph-child-words",
        title: "Play word connections",
        type: "words",
        kind: "self",
        mode: "associate",
        ages: ["child"],
        intro: "Say words out loud that go with the picture-word. Any answer is a good answer.",
        content: {
          1: { prompt: "toys", ideas: ["doll", "blocks", "swing", "puzzle", "kite"] },
          2: { prompt: "park", ideas: ["slide", "swing", "grass", "friends", "picnic"] },
          3: { prompt: "pets", ideas: ["puppy", "kitten", "leash", "treat", "bowl"] },
          4: { prompt: "story", ideas: ["dragon", "castle", "hero", "magic", "ending"] },
          5: { prompt: "birthday", ideas: ["cake", "candles", "friends", "song", "presents"] },
        },
        levels: ALL_LEVELS,
      },
      {
        id: "aph-teen-naming",
        title: "School and hobby naming",
        type: "picture",
        kind: "self",
        mode: "naming",
        ages: ["teenager"],
        intro: "Say the name of each picture out loud before you peek at the word.",
        content: {
          1: [
            { emoji: "🎧", word: "headphones" }, { emoji: "🛹", word: "skateboard" },
            { emoji: "📓", word: "notebook" }, { emoji: "🏀", word: "basketball" },
            { emoji: "🎒", word: "backpack" }, { emoji: "🎮", word: "game" },
          ],
          2: [
            { emoji: "🧪", word: "science lab" }, { emoji: "🧮", word: "calculator" },
            { emoji: "🖊️", word: "pen" }, { emoji: "🖥️", word: "computer" },
            { emoji: "⏰", word: "alarm" }, { emoji: "🥤", word: "soda" },
          ],
          3: [
            { emoji: "🎬", word: "movie" }, { emoji: "🍿", word: "popcorn" },
            { emoji: "🏟️", word: "stadium" }, { emoji: "🛼", word: "skates" },
            { emoji: "🧢", word: "cap" }, { emoji: "🧃", word: "juice" },
          ],
          4: [
            { emoji: "🎤", word: "microphone" }, { emoji: "🥁", word: "drum kit" },
            { emoji: "📸", word: "camera" }, { emoji: "🧲", word: "magnet" },
            { emoji: "🔋", word: "battery" }, { emoji: "💡", word: "bulb" },
          ],
          5: [
            { emoji: "🎓", word: "graduation" }, { emoji: "🏆", word: "trophy" },
            { emoji: "🎯", word: "target" }, { emoji: "🎳", word: "bowling" },
            { emoji: "🧗", word: "climbing" }, { emoji: "🎻", word: "violin" },
          ],
        },
        levels: ALL_LEVELS,
      },
      {
        id: "aph-teen-words",
        title: "Teen word connections",
        type: "words",
        kind: "self",
        mode: "associate",
        ages: ["teenager"],
        intro: "Say words out loud that connect to the prompt. Any answer is a good answer.",
        content: {
          1: { prompt: "music", ideas: ["song", "band", "chorus", "beat", "concert"] },
          2: { prompt: "team", ideas: ["practice", "coach", "jersey", "score", "warmup"] },
          3: { prompt: "class", ideas: ["locker", "quiz", "notes", "project", "bell"] },
          4: { prompt: "weekend", ideas: ["friends", "movie", "mall", "sleep", "plans"] },
          5: { prompt: "future", ideas: ["college", "job", "licence", "goal", "summer"] },
        },
        levels: ALL_LEVELS,
      },
    ],
  },

  dysarthria: {
    id: "dysarthria",
    title: "Articulation & intelligibility practice",
    blurb:
      "This path only contains activities configured by a speech-language pathologist. Dr. Sturgis does not create or validate these exercises.",
    clinicianGated: true,
    activities: [
      {
        id: "dys-artic",
        title: "Clinician-configured articulation / intelligibility drill",
        type: "clinician",
        kind: "clinician",
        clinicianKind: "articulation",
        ages: ["child", "teenager", "adult"],
        intro:
          "Practise the words and sentences your clinician chose for you, repeating each one clearly.",
        content: {},
        levels: ALL_LEVELS,
      },
    ],
  },

  apraxia: {
    id: "apraxia",
    title: "Sequencing practice (clinician-selected)",
    blurb:
      "Sequencing activities appear only after a speech-language pathologist enters the steps they selected for you.",
    clinicianGated: true,
    activities: [
      {
        id: "apx-seq",
        title: "Clinician-selected sequencing activity",
        type: "clinician",
        kind: "clinician",
        clinicianKind: "sequencing",
        ages: ["child", "teenager", "adult"],
        intro:
          "Practise the sequence your clinician selected. Order matters — follow the order they gave.",
        content: {},
        levels: ALL_LEVELS,
      },
    ],
  },

  abi: {
    id: "abi",
    title: "Communication goals (clinician-defined)",
    blurb:
      "Activities are driven by communication goals your clinician defined. Dr. Sturgis does not define clinical goals.",
    clinicianGated: true,
    activities: [
      {
        id: "abi-goals",
        title: "Clinician-defined goal practice",
        type: "clinician",
        kind: "clinician",
        clinicianKind: "goals",
        ages: ["child", "teenager", "adult"],
        intro: "Choose one of your clinician's goals and practise a matching communication activity.",
        content: {},
        levels: ALL_LEVELS,
      },
    ],
  },

  general: {
    id: "general",
    title: "Everyday speech practice",
    blurb:
      "Open self-practice for confidence and fluency of everyday communication — conversation, reading aloud and role-play.",
    clinicianGated: false,
    activities: [
      {
        id: "gen-convo",
        title: "Supportive conversation",
        type: "prompt",
        kind: "self",
        ages: ["adult"],
        intro: "Talk about these prompts out loud. No score, no timer.",
        content: {
          1: [
            "Say five household words out loud: kettle, mailbox, hallway, receipt, cushion.",
            "Name three things you used in the kitchen today.",
            "Say one word for the weather outside right now.",
          ],
          2: [
            "Finish this: “On my way home I usually…”",
            "Describe your commute or walk in one sentence.",
            "Say what you plan to cook or eat tonight, in one sentence.",
          ],
          3: [
            "Describe a regular evening at home, from arriving to settling in.",
            "Talk about a neighbour or local place you visit often.",
            "Explain how you like to spend a quiet Sunday.",
          ],
          4: [
            "Practise a building greeting: “Morning — did you see the notice about the lift?”",
            "You are asking a neighbour to collect a parcel. Say what you would say.",
            "Practise: “Sorry I missed your call. Is now a good time?”",
          ],
          5: [
            "Explain to a colleague how a household repair got sorted, from start to finish.",
            "Describe a community event you went to and who you spoke with.",
            "Talk through how you would reschedule a dinner with friends.",
          ],
        },
        levels: ALL_LEVELS,
      },
      {
        id: "gen-reading",
        title: "Reading aloud",
        type: "prompt",
        kind: "self",
        ages: ["adult"],
        intro: "Read each passage aloud at your own pace. Pause anywhere you need.",
        content: READING_PASSAGES,
        levels: ALL_LEVELS,
      },
      {
        id: "gen-roleplay",
        title: "Role-play scenarios",
        type: "prompt",
        kind: "self",
        ages: ["adult"],
        intro: "Pretend you are in this situation and say what you would really say.",
        content: ROLEPLAY_SCENARIOS,
        levels: ALL_LEVELS,
      },
      {
        id: "gen-teen-chat",
        title: "Hangout conversation",
        type: "prompt",
        kind: "self",
        ages: ["teenager"],
        intro: "Talk through these hangout situations out loud. No score and no timer.",
        content: {
          1: [
            "Say five weekend words: playlist, snacks, group chat, bus stop, hoodie.",
            "Name three apps or games you opened this week.",
            "Say one word for your mood after last period.",
          ],
          2: [
            "Finish this: “This weekend my friends and I…”",
            "In one sentence, say where you want to meet up.",
            "Tell someone what time the bus or ride leaves.",
          ],
          3: [
            "Describe a typical Friday afternoon from the last bell onward.",
            "Talk about a show or match you watched with friends.",
            "Explain the rules of a game you play online, in a few sentences.",
          ],
          4: [
            "Practise: “Want to come over and study for the quiz?”",
            "A group is choosing a film. Say which one you pick and why.",
            "Practise asking a classmate to save you a seat.",
          ],
          5: [
            "Tell a friend about a club, team, or project you joined this term.",
            "Explain how you would plan a birthday hangout on a small budget.",
            "A plan falls through. Say how you would suggest something else to do.",
          ],
        },
        levels: ALL_LEVELS,
      },
      {
        id: "gen-teen-read",
        title: "Read a teen note aloud",
        type: "prompt",
        kind: "self",
        ages: ["teenager"],
        intro: "Read each note aloud at your own pace.",
        content: {
          1: ["Read aloud: locker, quiz, chorus, jersey, playlist, hallway."],
          2: ["Read aloud: “Meet me by the gym after sixth period.”"],
          3: ["Read aloud: “Our group project is due Friday. I can bring the poster if you bring the notes.”"],
          4: ["Read aloud: “Hey — are you still coming to practice? I saved you a seat on the bus.”"],
          5: ["Read aloud: “The match starts at four. Bring water, wear the blue jersey, and be at the side gate ten minutes early so we can warm up together.”"],
        },
        levels: ALL_LEVELS,
      },
    ],
  },

  child: {
    id: "child",
    title: "Playful practice for children",
    blurb:
      "Picture-based storytelling and caregiver-supported games. A grown-up should help and play along.",
    clinicianGated: false,
    childPath: true,
    activities: [
      {
        id: "child-story",
        title: "Picture story time",
        type: "picture",
        kind: "self",
        mode: "story",
        ages: ["child"],
        caregiverNote: "Caregiver: ask “What happens next?” and let the child lead the story.",
        intro: "Look at the pictures and tell a story about them. There is no wrong story!",
        content: {
          1: [{ emoji: "🐱" }, { emoji: "🥛" }, { emoji: "🐶" }],
          2: [{ emoji: "🌞" }, { emoji: "👧" }, { emoji: "🚲" }, { emoji: "🌳" }],
          3: [{ emoji: "🌧️" }, { emoji: "🌂" }, { emoji: "💦" }, { emoji: "🐸" }],
          4: [{ emoji: "🎂" }, { emoji: "🎁" }, { emoji: "🎈" }, { emoji: "🧑‍🎤" }, { emoji: "🥳" }],
          5: [{ emoji: "🚀" }, { emoji: "🧑‍🚀" }, { emoji: "🌍" }, { emoji: "✨" }, { emoji: "🏠" }],
        },
        levels: ALL_LEVELS,
      },
      {
        id: "child-games",
        title: "Caregiver-supported word games",
        type: "prompt",
        kind: "self",
        ages: ["child"],
        caregiverNote: "Caregiver: play together, take turns, and keep it light — it's play, not a test.",
        intro: "Games to play together with a caregiver. Take turns and cheer each other on!",
        content: {
          1: [
            "With a caregiver: name five colours you can see in the room.",
            "Play “I spy” — one round each, taking turns.",
          ],
          2: [
            "Play the memory game: “I went to the market and I bought an apple…” take turns adding items.",
            "With a caregiver: name three animals and the sound each one makes.",
          ],
          3: [
            "Tell a caregiver the best part of your day in two or three sentences.",
            "With a caregiver: describe your favourite cartoon or game — what happens in it?",
          ],
          4: [
            "Practise asking a caregiver a question about their day, then listen to the answer.",
            "Role-play ordering an imaginary meal with a caregiver as the waiter.",
          ],
          5: [
            "Tell a caregiver a story from memory: a trip, a day out, or something funny that happened.",
            "With a caregiver: explain how to play your favourite game to someone who has never played it.",
          ],
        },
        levels: ALL_LEVELS,
      },
    ],
  },
};

/* ------------------------------------------------------------------
   Which paths are active for a profile
------------------------------------------------------------------ */
export function getActivePaths(profile = getProfile()) {
  if (!profile) return [];
  const age = profile.ageGroup || "adult";
  const ids = [];
  for (const need of profile.needs || []) {
    const id = need === "general" && age === "child" ? "child" : need;
    if (PATHS[id] && !ids.includes(id)) ids.push(id);
  }
  return ids
    .map((id) => {
      const path = PATHS[id];
      const activities = path.activities.filter((activity) => !activity.ages || activity.ages.includes(age));
      return { ...path, activities };
    })
    .filter((path) => path.activities.length);
}

/* ------------------------------------------------------------------
   Difficulty suggestions - comfort & goals ONLY, never fluency.
------------------------------------------------------------------ */
export function suggestLevel(profile, pathId, sessions, currentLevel) {
  const relevant = sessions.filter(
    (s) => s.pathId === pathId && s.reflection && typeof s.reflection.comfort === "number"
  );
  if (relevant.length < 2) return null;

  const recent = relevant.slice(-3);
  const avg = recent.reduce((sum, s) => sum + s.reflection.comfort, 0) / recent.length;

  if (avg >= 4 && currentLevel < 5) {
    const next = currentLevel + 1;
    return {
      level: next,
      direction: "up",
      reason:
        `Your last ${recent.length} sessions felt fairly comfortable to you (you rated them ` +
        `${recent.map((s) => s.reflection.comfort).join(", ")} out of 5). You could try Level ${next} — ` +
        `“${levelInfo(next).name}” — or stay right where you are. Suggestions only ever come from your ` +
        `own comfort ratings and goals, never from how fluent your speech sounds.`,
    };
  }
  if (avg <= 2 && currentLevel > 1) {
    const next = currentLevel - 1;
    return {
      level: next,
      direction: "down",
      reason:
        `You've rated your recent comfort a little low (${recent.map((s) => s.reflection.comfort).join(", ")} out of 5). ` +
        `You might enjoy Level ${next} — “${levelInfo(next).name}” — for a bit. Comfort comes first, and you ` +
        `can move back up whenever you like.`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------
   Render the Practice Paths section
------------------------------------------------------------------ */
export function renderPaths() {
  const root = $("#paths-root");
  if (!root) return;
  clear(root);

  const profile = getProfile();
  if (!profile) {
    root.append(
      el("div", { class: "empty" }, [
        el("span", { class: "empty-icon", text: "🧭" }),
        el("p", { text: "Set up your profile first and your practice paths will appear here." }),
        el("button", {
          class: "btn btn-primary",
          text: "Go to My Profile",
          attrs: { "data-goto": "profile" },
        }),
      ])
    );
    return;
  }

  const sessions = getSessions();
  const last = [...sessions].reverse().find((s) => findActivity(s.activityId));
  const choosingFresh = root.dataset.pickFresh === "1";
  delete root.dataset.pickFresh;
  const askWelcome = sessionStorage.getItem("patientai.pathsWelcome") !== "done";

  if (last && askWelcome && !choosingFresh) {
    sessionStorage.setItem("patientai.pathsWelcome", "done");
    const when = last.ts ? new Date(last.ts).toLocaleDateString() : "last time";
    root.append(
      el("div", { class: "card welcome-card" }, [
        el("h3", { text: "Welcome back" }),
        el("p", { text: `On ${when} you were practising “${last.activityTitle}”. Would you like to continue where you left off?` }),
        el("div", { class: "btn-row" }, [
          el("button", {
            type: "button",
            class: "btn btn-primary",
            text: "Yes, continue",
            onclick: () => {
              const found = findActivity(last.activityId);
              if (found) openPracticeAgent(found.activity, found.path);
              renderPaths();
            },
          }),
          el("button", {
            type: "button",
            class: "btn",
            text: "No, show me everything",
            onclick: () => {
              root.dataset.pickFresh = "1";
              renderPaths();
            },
          }),
        ]),
      ])
    );
    return;
  }

  renderActivityChoices(root, profile);
}

function activitiesForAge(age) {
  const items = [];
  for (const path of Object.values(PATHS)) {
    if (path.clinicianGated) continue;
    for (const activity of path.activities) {
      if (activity.ages && !activity.ages.includes(age)) continue;
      items.push({ activity, path });
    }
  }
  return items;
}

function findActivity(activityId) {
  for (const path of Object.values(PATHS)) {
    const activity = path.activities.find((item) => item.id === activityId);
    if (activity) return { activity, path };
  }
  return null;
}

function showAllActivities() {
  sessionStorage.setItem("patientai.pathsWelcome", "done");
  const root = $("#paths-root");
  if (root) root.dataset.pickFresh = "1";
  renderPaths();
}

function renderActivityChoices(root, profile) {
  const age = profile.ageGroup || "adult";
  const items = activitiesForAge(age);
  root.append(
    el("h3", { text: "What would you like to practise today?" }),
    el("p", { class: "muted", text: "These are all the speaking activities for your age group. Pick any box. You can choose a different one every time you come back." })
  );
  const grid = el("div", { class: "activity-grid" });
  for (const item of items) {
    grid.append(
      el("button", {
        type: "button",
        class: "activity-tile",
        onclick: () => openPracticeAgent(item.activity, item.path),
      }, [
        el("span", { class: "tile-title", text: item.activity.title }),
        el("span", { class: "tile-blurb", text: item.path.title }),
      ])
    );
  }
  if (!items.length) {
    root.append(el("p", { class: "muted", text: "No speaking activities are set up for this age group yet." }));
  }
  root.append(grid);
}

function practiceSeed(activity) {
  const content = activity.content || {};
  const pool = content[1] || content[Object.keys(content)[0]];
  if (Array.isArray(pool) && pool.length) {
    const first = pool[0];
    if (typeof first === "string") return first;
    if (first && first.emoji) return "Talk out loud about these pictures: " + pool.map((item) => item.emoji || item.word).filter(Boolean).join(" ");
  }
  if (pool && pool.prompt) return `Say words out loud that connect to “${pool.prompt}”.`;
  if (pool && pool.target) return `Say this sentence out loud: ${pool.target}`;
  return activity.intro || activity.title;
}

function renderPathCard(path, profile, sessions) {
  const levels = getLevels();
  const currentLevel = levels[path.id] || 1;
  const config = getClinician()[path.id];
  const suggestion = suggestLevel(profile, path.id, sessions, currentLevel);

  const card = el("div", { class: "card", attrs: { "data-path": path.id } });

  /* Head */
  card.append(
    el("div", { class: "card-head" }, [
      el("div", {}, [
        el("h3", { text: path.title }),
        el("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:4px" }, [
          el("span", {
            class: "badge " + (path.clinicianGated ? "badge-clinician" : "badge-self"),
            text: path.clinicianGated ? "Clinician-configured" : "Self-practice",
          }),
          path.childPath ? el("span", { class: "badge badge-child", text: "Child · caregiver-supported" }) : null,
          el("span", { class: "badge badge-level", text: `Level ${currentLevel}: ${levelInfo(currentLevel).name}` }),
        ]),
      ]),
    ]),
    el("p", { class: "muted", text: path.blurb })
  );

  /* Levels - always user-controlled */
  const levelRow = el("div", { class: "level-row", attrs: { role: "group", "aria-label": `Levels for ${path.title}` } });
  for (const lvl of LEVELS) {
    const btn = el("button", {
      type: "button",
      class:
        "level-btn" +
        (lvl.id === currentLevel ? " is-current" : "") +
        (suggestion && suggestion.level === lvl.id ? " is-suggested" : ""),
      attrs: { "aria-pressed": String(lvl.id === currentLevel) },
      onclick: () => {
        setLevel(path.id, lvl.id);
        toast(`Level set to ${lvl.id}: ${lvl.name}. You're in control — change it any time.`);
        renderPaths();
      },
    }, [
      el("span", { class: "lvl-num", text: String(lvl.id) }),
      el("span", { class: "lvl-name", text: lvl.name }),
      el("span", { class: "lvl-blurb", text: lvl.blurb }),
    ]);
    levelRow.append(btn);
  }
  card.append(levelRow);

  /* Suggestion box */
  if (suggestion) {
    card.append(
      el("div", { class: "suggest-box", role: "note" }, [
        el("strong", { text: "Optional suggestion: " }),
        document.createTextNode(suggestion.reason),
        el("div", { class: "btn-row", style: "margin-top:8px" }, [
          el("button", {
            type: "button",
            class: "btn btn-small btn-accent",
            text: `Try Level ${suggestion.level}`,
            onclick: () => {
              setLevel(path.id, suggestion.level);
              toast(`You're now on Level ${suggestion.level}. You can switch back any time.`);
              renderPaths();
            },
          }),
          el("button", {
            type: "button",
            class: "btn btn-small",
            text: "Keep my level",
            onclick: () => {
              toast("Kept your current level.");
              renderPaths();
            },
          }),
        ]),
      ])
    );
  }

  /* Clinician gate */
  if (path.clinicianGated) {
    if (!config) {
      card.append(
        el("div", { class: "notice notice-lock", style: "margin-top:12px" }, [
          el("strong", { text: "🔒 Locked until a clinician configures it. " }),
          document.createTextNode(
            "This path only runs activities your speech-language pathologist set up. " +
            "Dr. Sturgis does not create these exercises itself. If you have been given a " +
            "written configuration (word lists, sequence steps or goals), enter it below — " +
            "or ask your clinician for it."
          ),
          el("div", { class: "btn-row", style: "margin-top:10px" }, [
            el("button", {
              type: "button",
              class: "btn btn-small btn-primary",
              text: "Enter clinician configuration",
              onclick: () => openClinicianConfig(path),
            }),
          ]),
        ])
      );
      return card;
    }
    card.append(
      el("div", { class: "notice", style: "margin-top:12px" }, [
        el("strong", { text: "Clinician configuration active. " }),
        document.createTextNode(
          `Set for this device on ${new Date(config.savedAt).toLocaleDateString()}. ` +
          "Only follow this configuration if your clinician provided it."
        ),
        " ",
        el("button", {
          type: "button",
          class: "btn btn-small",
          text: "Edit / remove",
          onclick: () => openClinicianConfig(path),
        }),
      ])
    );
  }

  /* Activities */
  const list = el("div", { class: "stack", style: "margin-top:12px" });
  for (const activity of path.activities) {
    if (!activity.levels.includes(currentLevel)) continue;
    list.append(renderActivityRow(activity, path, currentLevel, config));
  }
  card.append(list);

  return card;
}

function renderActivityRow(activity, path, level, config) {
  const row = el("div", {
    class: "notice",
    style: "display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap",
  });
  row.append(
    el("div", {}, [
      el("strong", { text: activity.title }),
      activity.optional ? el("span", { class: "badge", text: "Optional", style: "margin-left:6px" }) : null,
      activity.kind === "clinician"
        ? el("span", { class: "badge badge-clinician", text: "Clinician-configured", style: "margin-left:6px" })
        : el("span", { class: "badge badge-self", text: "Self-practice", style: "margin-left:6px" }),
      el("p", { class: "muted small", style: "margin:4px 0 0", text: activity.intro }),
      activity.caregiverNote
        ? el("p", { class: "small", style: "margin:4px 0 0;color:#a43a76", text: "🧒 " + activity.caregiverNote })
        : null,
    ]),
    el("button", {
      type: "button",
      class: "btn btn-small btn-primary",
      text: "Start",
      attrs: { "aria-label": `Start ${activity.title} at level ${level}` },
      onclick: () => {
        openRunner(activity, path, level, config);
      },
    })
  );
  return row;
}

/* ------------------------------------------------------------------
   Clinician configuration dialog
------------------------------------------------------------------ */
function openClinicianConfig(path) {
  const existing = getClinician()[path.id] || {};
  const body = clear(el("div"));

  body.append(
    el("div", { class: "notice notice-lock" }, [
      el("strong", { text: "For speech-language pathologists (or users following their instructions). " }),
      document.createTextNode(
        "Enter only what your clinician gave you. Dr. Sturgis does not generate, prescribe or " +
        "validate these activities — it simply runs what is entered here, on this device."
      ),
    ])
  );

  const fields = [];
  const addField = (key, label, placeholder, value) => {
    const input = el("textarea", {
      class: "input",
      attrs: { placeholder, rows: "4", id: `cfg-${path.id}-${key}` },
    });
    input.value = value || "";
    fields.push([key, input]);
    body.append(el("div", { style: "margin-top:12px" }, [
      el("label", { attrs: { for: input.id }, text: label }),
      input,
    ]));
  };

  if (path.id === "dysarthria") {
    addField("words", "Words to practise (comma or new line separated)", "apple, banana, mother, happy", existing.words);
    addField("sentences", "Sentences to practise (one per line)", "The weather is nice today.\nI would like a glass of water.", existing.sentences);
  } else if (path.id === "apraxia") {
    addField("steps", "Sequence steps, in the clinician's chosen order (one per line)", "ma\nmama\nmama milk", existing.steps);
  } else if (path.id === "abi") {
    addField("goals", "Communication goals defined by the clinician (one per line)", "Order lunch using short phrases\nAsk for a break when needed", existing.goals);
    addField("notes", "Clinician notes (optional)", "Keep sessions short; allow extra time.", existing.notes);
  }

  const error = el("p", { class: "notice notice-warn", role: "alert", hidden: true });

  body.append(
    error,
    el("div", { class: "btn-row", style: "margin-top:14px" }, [
      el("button", {
        type: "button",
        class: "btn btn-primary",
        text: "Save configuration",
        onclick: () => {
          const config = {};
          let empty = true;
          for (const [key, input] of fields) {
            config[key] = input.value.trim();
            if (config[key]) empty = false;
          }
          if (empty) {
            error.hidden = false;
            error.textContent = "Enter at least one item from your clinician before saving.";
            return;
          }
          saveClinician(path.id, config);
          closeModal();
          toast("Clinician configuration saved on this device.");
          emit("patientai:data");
          renderPaths();
        },
      }),
      existing.words || existing.steps || existing.goals
        ? el("button", {
            type: "button",
            class: "btn btn-danger",
            text: "Remove configuration",
            onclick: () => {
              clearClinician(path.id);
              closeModal();
              toast("Configuration removed. The path is locked again.");
              renderPaths();
            },
          })
        : null,
      el("button", { type: "button", class: "btn", text: "Cancel", onclick: closeModal }),
    ])
  );

  openModal(`Clinician configuration · ${path.title}`, body);
}

/* ------------------------------------------------------------------
   Activity runner
------------------------------------------------------------------ */
function openVoicePractice(activity, path) {
  const profile = getProfile();
  const seed = practiceSeed(activity);
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  let listeningReady = false;
  const body = openModal(activity.title, null, {
    wide: true,
    onClose: () => { if (listeningReady) stopPractice(true); },
  });
  const log = el("div", { class: "log", attrs: { role: "log", "aria-label": "Practice transcript" } });
  const status = el("p", { class: "muted", text: "Press Start talking and speak. Repeats and filler words are highlighted in your words." });
  const startBtn = el("button", { type: "button", class: "btn btn-primary btn-big", text: "Start talking" });
  const stopBtn = el("button", { type: "button", class: "btn", text: "Stop", attrs: { disabled: true } });
  const allBtn = el("button", {
    type: "button",
    class: "btn",
    text: "All activities",
    onclick: () => {
      closeModal();
      showAllActivities();
    },
  });
  body.append(
    el("div", { class: "practice-idea" }, [
      el("strong", { text: "Say this out loud. " }),
      document.createTextNode(seed),
    ]),
    status,
    log,
    el("div", { class: "btn-row", style: "margin-top:12px" }, [startBtn, stopBtn, allBtn])
  );
  if (!SpeechRec) {
    status.textContent = "This browser can't listen yet. Open Dr. Sturgis in Chrome or Edge to talk with the practice partner.";
    startBtn.disabled = true;
    return;
  }

  const turns = [];
  listeningReady = true;
  let recognition = null;
  let running = false;
  let pending = "";
  let bestInterim = "";
  let timer = null;
  let saved = false;
  const recorder = createUtteranceRecorder();
  const startedAt = Date.now();

  const paint = () => {
    clear(log);
    if (!turns.length) {
      log.append(el("p", { class: "muted small", text: "Your words will show up here, with repeats and fillers marked." }));
      return;
    }
    for (const turn of turns) {
      const bubble = el("div", { class: "msg " + (turn.role === "user" ? "msg-user" : "msg-ai") });
      if (turn.role === "user") appendMarkedTranscript(bubble, turn.text);
      else bubble.append(document.createTextNode(turn.text));
      log.append(bubble);
    }
    log.scrollTop = log.scrollHeight;
  };
  paint();

  const repeatScore = (text) => {
    const words = String(text || "").toLowerCase().match(/[a-z']+/g) || [];
    let score = 0;
    for (let i = 1; i < words.length; i++) if (words[i] === words[i - 1]) score += 2;
    if (/\b(um|uh|er|ah|hmm)\b/i.test(text)) score += 1;
    return score;
  };

  async function speak(text) {
    await speakSoft(text);
  }

  async function finishUtterance() {
    const browserText = pending.trim();
    pending = "";
    bestInterim = "";
    try { recognition && recognition.stop(); } catch { /* ignore */ }
    let text = browserText;
    const blob = await recorder.stop();
    if (blob) {
      status.textContent = "Writing down your words, including pauses and repeats…";
      try {
        text = richerTranscript(browserText, await transcribeBlob(blob));
      } catch {
        text = browserText;
      }
    }
    if (!text) {
      if (running) {
        status.textContent = "Listening…";
        try { recorder.start(); recognition && recognition.start(); } catch { /* ignore */ }
      }
      return;
    }
    try {
      const detected = await detectEvents(text, null, null);
      const extras = (detected.events || []).map((event) => event.detail).filter(Boolean);
      if (extras.length && !/\b(\w+)\s+\1\b/i.test(text) && !/\b(um|uh|er|ah|hmm)\b/i.test(text)) {
        // Keep the spoken line as the transcript. Highlights come from the words themselves.
      }
    } catch { /* the transcript still shows whatever was heard */ }
    turns.push({ role: "user", text });
    paint();
    status.textContent = "Thinking…";
    let reply = "I'm here. Say a little more whenever you're ready.";
    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          context: {
            ageGroup: profile?.ageGroup,
            needs: profile?.needs,
            goals: profile?.goals,
            comfort: profile?.comfort,
            pathTitle: path.title,
            activityTitle: activity.title,
            practicePrompt: seed,
          },
          history: turns.slice(-6, -1),
        }),
      });
      const data = await resp.json();
      if (resp.ok && data.reply) reply = data.reply;
    } catch { /* keep the gentle fallback */ }
    turns.push({ role: "assistant", text: reply });
    paint();
    status.textContent = "Speaking…";
    await speak(reply);
    if (running) {
      status.textContent = "Listening…";
      try { recorder.start(); recognition && recognition.start(); } catch { /* ignore */ }
    } else {
      status.textContent = "Stopped.";
    }
  }

  async function begin() {
    if (!hasConsent()) {
      const granted = await showConsentModal();
      if (!granted) return;
    }
    if (!recognition) {
      recognition = new SpeechRec();
      recognition.lang = navigator.language || "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        let interim = "";
        let finalChunk = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalChunk += piece;
          else interim += piece;
        }
        if (interim && repeatScore(interim) >= repeatScore(bestInterim)) bestInterim = interim;
        if (finalChunk.trim()) {
          const chosen = repeatScore(bestInterim) > repeatScore(finalChunk) ? bestInterim : finalChunk;
          bestInterim = "";
          pending = (pending + " " + chosen).trim();
          clearTimeout(timer);
          timer = setTimeout(finishUtterance, 1200);
        }
      };
      recognition.onend = () => {
        if (running && !timer) {
          try { recognition.start(); } catch { /* ignore */ }
        }
      };
    }
    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    status.textContent = "Listening…";
    try { await recorder.arm(); recorder.start(); } catch { /* browser text still works */ }
    try { recognition.start(); } catch { /* already started */ }
  }

  function stopPractice(silent) {
    running = false;
    clearTimeout(timer);
    try { recognition && recognition.stop(); } catch { /* ignore */ }
    recorder.release();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (!saved && turns.some((turn) => turn.role === "user")) {
      saved = true;
      const said = turns.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" ");
      logSession({
        mode: "voice-practice",
        pathId: path.id,
        pathTitle: path.title,
        activityId: activity.id,
        activityTitle: activity.title,
        level: 1,
        durationSec: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
        transcript: said.slice(0, 1200),
        reflection: null,
      });
      emit("patientai:data");
      if (!silent) toast("Practice saved. You can continue it next time.");
    }
    if (!silent) closeModal();
  }

  startBtn.addEventListener("click", begin);
  stopBtn.addEventListener("click", () => stopPractice(false));
}

function openRunner(activity, path, level, config) {
  const startedAt = Date.now();
  const container = el("div");
  openModal(`${activity.title} · Level ${level}`, container);

  const finish = (extra = {}) => {
    openReflection((reflection) => {
      logSession({
        pathId: path.id,
        pathTitle: path.title,
        activityId: activity.id,
        activityTitle: activity.title,
        level,
        mode: "activity",
        durationSec: Math.round((Date.now() - startedAt) / 1000),
        reflection,
        ...extra,
      });
      closeModal();
      toast("Session saved to your Progress.");
      emit("patientai:data");
    });
  };

  if (activity.type === "prompt") runPrompt(container, activity, level, finish);
  else if (activity.type === "picture") runPicture(container, activity, level, finish);
  else if (activity.type === "words") runWords(container, activity, level, finish);
  else if (activity.type === "clinician") runClinician(container, activity, path, level, config, finish);
}

/* ---- generic prompt runner ---- */
function runPrompt(container, activity, level, finish) {
  const pool = activity.content[level] || activity.content[1] || [];
  let index = Math.floor(Math.random() * pool.length);

  const promptBox = el("div", { class: "prompt-box" });
  const show = () => {
    promptBox.textContent = pool[index];
  };
  show();

  const parts = [el("p", { class: "muted", text: activity.intro })];
  if (activity.caregiverNote) {
    parts.push(el("div", { class: "notice", style: "margin-bottom:10px" }, ["🧒 " + activity.caregiverNote]));
  }
  parts.push(
    promptBox,
    el("div", { class: "btn-row", style: "margin-top:12px" }, [
      el("button", {
        type: "button",
        class: "btn",
        text: "Another prompt",
        onclick: () => {
          if (pool.length > 1) {
            index = (index + 1) % pool.length;
            show();
          }
        },
      }),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        text: "Done with this one",
        onclick: () => finish({}),
      }),
    ])
  );
  container.append(...parts);
}

/* ---- picture runner (naming + storytelling) ---- */
function runPicture(container, activity, level, finish) {
  const items = activity.content[level] || activity.content[1] || [];
  let index = 0;
  let revealed = false;
  let named = 0;
  let helped = 0;

  const stage = el("div");
  const render = () => {
    clear(stage);
    if (index >= items.length) {
      stage.append(
        el("div", { class: "empty" }, [
          el("span", { class: "empty-icon", text: "🎉" }),
          el("p", {
            text: activity.mode === "naming"
              ? `That's all ${items.length} pictures. Ready to wrap up?`
              : "Great storytelling! Ready to wrap up?",
          }),
          el("button", {
            type: "button",
            class: "btn btn-primary",
            text: "Finish & reflect",
            onclick: () => finish(
              activity.mode === "naming" ? { activityStats: { named, helped, total: items.length } } : {}
            ),
          }),
        ])
      );
      return;
    }

    const item = items[index];
    if (activity.mode === "naming") {
      stage.append(el("p", { class: "muted small", text: `Picture ${index + 1} of ${items.length}` }));
    }
    stage.append(
      activity.mode === "story"
        ? el("div", { class: "word-bank" }, items.map((s) => el("span", { text: s.emoji, style: "font-size:2rem" })))
        : pictureVisual(item)
    );

    if (activity.mode === "naming") {
      const wordBox = el("p", { class: "runner-word", hidden: true, text: item.word });
      stage.append(
        el("p", { class: "muted", text: "Say the name of this picture out loud." }),
        wordBox,
        el("div", { class: "btn-row", style: "justify-content:center" }, [
          el("button", {
            type: "button",
            class: "btn",
            text: revealed ? "Hide word" : "Reveal the word (hint)",
            onclick: () => {
              revealed = !revealed;
              wordBox.hidden = !revealed;
            },
          }),
          el("button", {
            type: "button",
            class: "btn btn-primary",
            text: "Next picture",
            onclick: () => {
              if (revealed) helped += 1;
              else named += 1;
              revealed = false;
              index += 1;
              render();
            },
          }),
        ])
      );
    } else {
      // story mode
      const storyParts = [
        el("p", { text: "Tell a story using these pictures. Say it out loud — silly stories are welcome!" }),
      ];
      if (activity.caregiverNote) {
        storyParts.push(el("div", { class: "notice" }, ["🧒 " + activity.caregiverNote]));
      }
      storyParts.push(
        el("button", {
          type: "button",
          class: "btn btn-primary",
          text: "We told the story!",
          onclick: () => finish({}),
        })
      );
      stage.append(...storyParts);
    }
  };

  container.append(el("p", { class: "muted", text: activity.intro }), stage);
  render();
}

/* ---- word association / sentence building ---- */
function runWords(container, activity, level, finish) {
  const data = activity.content[level] || activity.content[1];
  container.append(el("p", { class: "muted", text: activity.intro }));

  if (activity.mode === "associate") {
    const chips = el("div", { class: "chip-row", style: "margin:10px 0" });
    const ideasBox = el("div", { hidden: true });
    let said = 0;

    container.append(
      el("div", { class: "prompt-box" }, [
        el("span", { class: "muted small", text: "Say words out loud that connect to…" }),
        el("div", { style: "font-size:1.6rem;font-weight:700", text: data.prompt }),
      ]),
      el("p", { class: "muted small", text: "Say a word, then tap once so you can keep count. Nothing is typed." }),
      chips,
      el("div", { class: "btn-row", style: "margin-top:10px" }, [
        el("button", {
          type: "button",
          class: "btn",
          text: "I said a word",
          onclick: () => {
            said += 1;
            chips.append(el("span", { class: "chip is-active", text: `Spoken ${said}` }));
          },
        }),
        el("button", {
          type: "button",
          class: "btn",
          text: "Show some ideas",
          onclick: () => {
            clear(ideasBox);
            ideasBox.hidden = false;
            ideasBox.append(
              el("div", { class: "notice", style: "margin-top:10px" }, [
                el("strong", { text: "Ideas: " }),
                document.createTextNode(data.ideas.join(" · ")),
              ])
            );
          },
        }),
        el("button", {
          type: "button",
          class: "btn btn-primary",
          text: "Done",
          onclick: () => finish({}),
        }),
      ]),
      ideasBox
    );
    return;
  }

  // sentence building
  const shuffled = [...data.words].sort(() => Math.random() - 0.5);
  const built = [];
  const bank = el("div", { class: "word-bank" });
  const builtBox = el("div", { class: "built-sentence" });
  const result = el("div", { class: "check-result", hidden: true });

  const renderBank = () => {
    clear(bank);
    shuffled.forEach((word, i) => {
      if (built.some((b) => b.word === word && b.index === i)) return;
      bank.append(
        el("button", {
          type: "button",
          class: "chip",
          text: word,
          onclick: () => {
            built.push({ word, index: i });
            renderAll();
          },
        })
      );
    });
    if (shuffled.every((w, i) => built.some((b) => b.index === i))) {
      bank.append(el("span", { class: "muted small", text: "All words used" }));
    }
  };

  const renderBuilt = () => {
    clear(builtBox);
    built.forEach((b, pos) => {
      builtBox.append(
        el("button", {
          type: "button",
          class: "chip is-active",
          text: b.word,
          attrs: { "aria-label": `Remove ${b.word}` },
          onclick: () => {
            built.splice(pos, 1);
            renderAll();
          },
        })
      );
    });
  };

  const renderAll = () => {
    renderBank();
    renderBuilt();
    result.hidden = true;
  };

  container.append(
    el("div", { class: "prompt-box" }, [
      el("span", { class: "muted small", text: "Build this sentence, then say it out loud:" }),
      el("div", { style: "font-size:1.15rem;font-weight:700;margin-top:6px", text: data.target }),
    ]),
    builtBox,
    bank,
    el("div", { class: "btn-row", style: "margin-top:10px;justify-content:center" }, [
      el("button", {
        type: "button",
        class: "btn",
        text: "Check",
        onclick: () => {
          const attempt = built.map((b) => b.word).join(" ");
          const ok = attempt === data.words.join(" ");
          result.hidden = false;
          result.className = "check-result " + (ok ? "check-ok" : "check-retry");
          result.textContent = ok
            ? "✅ Perfect — now say the whole sentence out loud."
            : "Not quite yet — tap words to remove them and try again.";
        },
      }),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        text: "Done",
        onclick: () => finish({}),
      }),
    ]),
    result
  );
  renderAll();
}

/* ---- clinician-configured runners ---- */
function runClinician(container, activity, path, level, config, finish) {
  if (!config) {
    container.append(
      el("div", { class: "notice notice-lock" }, [
        el("strong", { text: "No configuration found. " }),
        document.createTextNode("Ask your speech-language pathologist for the activity setup for this path."),
      ])
    );
    return;
  }

  if (activity.clinicianKind === "articulation") {
    const words = (config.words || "")
      .split(/[,\n]+/)
      .map((w) => w.trim())
      .filter(Boolean);
    const sentences = (config.sentences || "")
      .split(/\n+/)
      .map((w) => w.trim())
      .filter(Boolean);
    const items = [...words, ...sentences];
    if (!items.length) {
      container.append(el("div", { class: "notice notice-lock", text: "The configuration is empty." }));
      return;
    }
    let index = 0;
    const stage = el("div");
    const render = () => {
      clear(stage);
      if (index >= items.length) {
        stage.append(
          el("div", { class: "empty" }, [
            el("span", { class: "empty-icon", text: "🎉" }),
            el("p", { text: "You worked through the whole list." }),
            el("button", { type: "button", class: "btn btn-primary", text: "Finish & reflect", onclick: () => finish({}) }),
          ])
        );
        return;
      }
      stage.append(
        el("p", { class: "muted small", text: `Item ${index + 1} of ${items.length}` }),
        el("div", { class: "prompt-box", style: "font-size:1.3rem;font-weight:700", text: items[index] }),
        el("p", { class: "muted", text: "Say it clearly a few times, at whatever pace your clinician recommended." }),
        el("div", { class: "btn-row", style: "justify-content:center" }, [
          el("button", { type: "button", class: "btn", text: "Skip this one", onclick: () => { index += 1; render(); } }),
          el("button", { type: "button", class: "btn btn-primary", text: "Done ✓", onclick: () => { index += 1; render(); } }),
        ])
      );
    };
    container.append(
      el("div", { class: "notice notice-lock" }, ["🔒 Clinician-configured activity — configured on this device."]),
      stage
    );
    render();
    return;
  }

  if (activity.clinicianKind === "sequencing") {
    const steps = (config.steps || "")
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (steps.length < 2) {
      container.append(
        el("div", { class: "notice notice-lock", text: "Add at least two sequence steps in the configuration." })
      );
      return;
    }
    const correct = steps.map((s, i) => ({ s, i }));
    let order = [...correct].sort(() => Math.random() - 0.5);
    let placed = [];
    const bank = el("div", { class: "word-bank" });
    const placedBox = el("div", { class: "built-sentence" });
    const result = el("div", { class: "check-result", hidden: true });

    const render = () => {
      clear(bank);
      clear(placedBox);
      result.hidden = true;
      for (const item of order) {
        if (placed.includes(item)) continue;
        bank.append(
          el("button", {
            type: "button",
            class: "chip",
            text: item.s,
            onclick: () => {
              placed.push(item);
              render();
            },
          })
        );
      }
      placed.forEach((item, pos) => {
        placedBox.append(
          el("button", {
            type: "button",
            class: "chip is-active",
            text: item.s,
            attrs: { "aria-label": `Remove step ${item.s}` },
            onclick: () => {
              placed.splice(pos, 1);
              render();
            },
          })
        );
      });
    };

    container.append(
      el("div", { class: "notice notice-lock" }, [
        "🔒 Clinician-selected sequence. Put the steps in the order your clinician gave them, then practise saying them in order.",
      ]),
      placedBox,
      bank,
      el("div", { class: "btn-row", style: "margin-top:10px" }, [
        el("button", {
          type: "button",
          class: "btn",
          text: "Check order",
          onclick: () => {
            const ok = placed.length === correct.length && placed.every((p, i) => p.i === i);
            result.hidden = false;
            result.className = "check-result " + (ok ? "check-ok" : "check-retry");
            result.textContent = ok
              ? "✅ Correct order — now say the sequence out loud."
              : "Not the clinician's order yet — adjust and check again.";
          },
        }),
        el("button", {
          type: "button",
          class: "btn btn-primary",
          text: "Done",
          onclick: () => finish({}),
        }),
      ]),
      result
    );
    render();
    return;
  }

  if (activity.clinicianKind === "goals") {
    const goals = (config.goals || "")
      .split(/\n+/)
      .map((g) => g.trim())
      .filter(Boolean);
    if (!goals.length) {
      container.append(el("div", { class: "notice notice-lock", text: "No goals in the configuration yet." }));
      return;
    }
    let chosen = null;
    const list = el("div", { class: "stack" });
    const promptBox = el("div", { class: "prompt-box", hidden: true });

    goals.forEach((goal) => {
      list.append(
        el("div", {
          class: "notice",
          style: "display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap",
        }, [
          el("span", { text: goal }),
          el("button", {
            type: "button",
            class: "btn btn-small btn-primary",
            text: "Practise this goal",
            onclick: () => {
              chosen = goal;
              promptBox.hidden = false;
              const age = getProfile()?.ageGroup;
              const pools = age === "child"
                ? PATHS.stuttering.activities.find((a) => a.id === "stut-child-play")?.content
                : age === "teenager"
                  ? PATHS.stuttering.activities.find((a) => a.id === "stut-teen-talk")?.content
                  : CONVERSATION_PROMPTS;
              const prompts = (pools && (pools[level] || pools[1])) || [];
              promptBox.textContent = prompts[Math.floor(Math.random() * Math.max(prompts.length, 1))] || "Say this goal out loud in your own words.";
              toast("Goal selected — do the prompt, then finish.");
              promptBox.scrollIntoView({ block: "nearest" });
            },
          }),
        ])
      );
    });

    container.append(
      el("div", { class: "notice notice-lock" }, [
        el("strong", { text: "🔒 Clinician-defined communication goals. " }),
        document.createTextNode("Dr. Sturgis did not create these goals."),
      ]),
      list,
      promptBox,
      el("div", { class: "btn-row", style: "margin-top:12px" }, [
        el("button", {
          type: "button",
          class: "btn btn-primary",
          text: "Done",
          onclick: () => {
            if (!chosen) {
              toast("Pick a goal first (or press Done to just log the session).", { error: true });
            }
            finish({ goal: chosen || undefined });
          },
        }),
      ])
    );
    if (config.notes) {
      container.append(el("div", { class: "notice", style: "margin-top:10px" }, ["Clinician notes: " + config.notes]));
    }
  }
}

/* ------------------------------------------------------------------
   Reflection (end of session)
------------------------------------------------------------------ */
function openReflection(onSave) {
  const body = clear(el("div"));
  const comfortLabels = {
    1: "1 · Very unsure",
    2: "2 · Nervous",
    3: "3 · Getting there",
    4: "4 · Fairly comfortable",
    5: "5 · Very comfortable",
  };
  const output = el("output", { class: "range-value", text: comfortLabels[3] });
  const slider = el("input", {
    type: "range", min: "1", max: "5", step: "1", value: "3",
    attrs: { "aria-label": "How comfortable did that feel?" },
  });
  slider.addEventListener("input", () => {
    output.textContent = comfortLabels[slider.value];
  });
  const note = el("textarea", {
    class: "input",
    attrs: { rows: "3", placeholder: "Optional: what felt good? what was tricky? (only you see this)" },
  });

  body.append(
    el("h3", { text: "How did that feel?" }),
    el("p", { class: "muted small", text: "Your comfort rating drives future level suggestions. There are no wrong answers, and nothing is scored." }),
    el("div", { class: "range-wrap" }, [slider, output]),
    el("div", { style: "margin-top:12px" }, [
      el("label", { text: "Anything you'd like to remember?" }),
      note,
    ]),
    el("div", { class: "btn-row", style: "margin-top:14px" }, [
      el("button", {
        type: "button",
        class: "btn btn-primary",
        text: "Save session",
        onclick: () => {
          onSave({ comfort: Number(slider.value), note: note.value.trim() || undefined });
        },
      }),
      el("button", {
        type: "button",
        class: "btn",
        text: "Skip",
        onclick: () => onSave({ comfort: null, skipped: true }),
      }),
    ])
  );

  // Replace the runner modal content with the reflection
  const modalBody = $("#app-modal-body");
  clear(modalBody).append(body);
  $("#app-modal-title").textContent = "Session reflection";
}

