// Shortcode to character, for `:warning:` and friends.
//
// @lezer/markdown's Emoji extension finds `:name:` and marks it as a node. It
// does not know what any name means — there is no shortcode table in the
// browser, and CLDR annotation names are not exposed by Intl — so the mapping
// has to come from somewhere, and this is it.
//
// **Curated, not exhaustive.** The full GitHub set is ~1800 entries and would
// be the largest file in this project by some way, for a feature that is
// convenience. What is here is the set people actually type in a document
// about work: status, reactions, the objects that come up in a changelog.
//
// An unknown shortcode is left as literal text, which is the right failure:
// `:sparkles:` in a `.md` file read by anything else is literal text too, so
// the document reads the same everywhere. Adding one is a line here.
//
// Grouped rather than flat, because the picker needs the grouping and a second
// list of categories would be the same fact written twice. Order is the order
// the picker shows.
export const EMOJI_GROUPS = [
  {
    name: 'Status',
    entries: {
      white_check_mark: '✅', heavy_check_mark: '✔️', x: '❌', warning: '⚠️',
      no_entry: '⛔', no_entry_sign: '🚫', bangbang: '‼️', exclamation: '❗',
      question: '❓', grey_question: '❔', information_source: 'ℹ️', bulb: '💡',
      zap: '⚡', boom: '💥', fire: '🔥', sparkles: '✨', star: '⭐', star2: '🌟',
      tada: '🎉', confetti_ball: '🎊', rocket: '🚀', construction: '🚧',
      lock: '🔒', unlock: '🔓', key: '🔑', shield: '🛡️', bug: '🐛', beetle: '🪲',
      wrench: '🔧', hammer: '🔨', hammer_and_wrench: '🛠️', gear: '⚙️',
      recycle: '♻️', broom: '🧹', pushpin: '📌', round_pushpin: '📍',
      triangular_flag_on_post: '🚩', checkered_flag: '🏁', trophy: '🏆',
      medal: '🏅', dart: '🎯', hourglass: '⌛', hourglass_flowing_sand: '⏳',
      stopwatch: '⏱️', alarm_clock: '⏰', calendar: '📅', date: '📆',
    },
  },
  {
    name: 'Reactions',
    entries: {
      thumbsup: '👍', thumbsdown: '👎', ok_hand: '👌', clap: '👏', wave: '👋',
      raised_hands: '🙌', pray: '🙏', muscle: '💪', point_right: '👉',
      point_left: '👈', point_up: '☝️', point_down: '👇', eyes: '👀',
      brain: '🧠', heart: '❤️', broken_heart: '💔', hearts: '💕',
      smile: '😄', smiley: '😃', grin: '😁', joy: '😂', rofl: '🤣',
      slightly_smiling_face: '🙂', wink: '😉', sunglasses: '😎',
      thinking: '🤔', neutral_face: '😐', expressionless: '😑',
      confused: '😕', frowning: '😦', cry: '😢', sob: '😭', scream: '😱',
      sweat_smile: '😅', grimacing: '😬', upside_down_face: '🙃',
      partying_face: '🥳', exploding_head: '🤯', shrug: '🤷', facepalm: '🤦',
      see_no_evil: '🙈', hear_no_evil: '🙉', speak_no_evil: '🙊',
    },
  },
  {
    name: 'Documents',
    entries: {
      memo: '📝', pencil: '✏️', page_facing_up: '📄', pages: '📃',
      clipboard: '📋', bookmark: '🔖', bookmark_tabs: '📑', books: '📚',
      book: '📖', notebook: '📓', ledger: '📒', card_index: '📇',
      file_folder: '📁', open_file_folder: '📂', card_file_box: '🗃️',
      package: '📦', inbox_tray: '📥', outbox_tray: '📤', mailbox: '📫',
      email: '📧', envelope: '✉️', paperclip: '📎', scissors: '✂️',
      printer: '🖨️', chart_with_upwards_trend: '📈',
      chart_with_downwards_trend: '📉', bar_chart: '📊', mag: '🔍',
      mag_right: '🔎', microscope: '🔬', telescope: '🔭', link: '🔗',
      scroll: '📜', label: '🏷️', money_with_wings: '💸', moneybag: '💰',
    },
  },
  {
    name: 'Machines & places',
    entries: {
      computer: '💻', desktop_computer: '🖥️', keyboard: '⌨️',
      floppy_disk: '💾', minidisc: '💽', cd: '💿', dvd: '📀',
      electric_plug: '🔌', battery: '🔋', satellite: '🛰️',
      iphone: '📱', telephone: '☎️', phone: '☎️', bell: '🔔', no_bell: '🔕',
      loudspeaker: '📢', mega: '📣', speech_balloon: '💬',
      thought_balloon: '💭', globe_with_meridians: '🌐', earth_africa: '🌍',
      house: '🏠', office: '🏢', factory: '🏭', bank: '🏦', hospital: '🏥',
    },
  },
  {
    name: 'Nature',
    entries: {
      sunny: '☀️', cloud: '☁️', rain_cloud: '🌧️', snowflake: '❄️',
      umbrella: '☔', rainbow: '🌈', ocean: '🌊', droplet: '💧',
      seedling: '🌱', herb: '🌿', four_leaf_clover: '🍀', maple_leaf: '🍁',
      fallen_leaf: '🍂', evergreen_tree: '🌲', cactus: '🌵', mushroom: '🍄',
      snail: '🐌', turtle: '🐢', rabbit: '🐰', whale: '🐳', dolphin: '🐬',
      penguin: '🐧', owl: '🦉', dog: '🐶', cat: '🐱', bee: '🐝', ant: '🐜',
    },
  },
  {
    name: 'Food',
    entries: {
      coffee: '☕', tea: '🍵', beer: '🍺', beers: '🍻', wine_glass: '🍷',
      champagne: '🍾', cake: '🍰', birthday: '🎂', cookie: '🍪',
      doughnut: '🍩', pizza: '🍕', hamburger: '🍔', taco: '🌮', apple: '🍎',
      watermelon: '🍉', banana: '🍌', avocado: '🥑', bread: '🍞', salt: '🧂',
    },
  },
  {
    name: 'Symbols',
    entries: {
      arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️',
      arrows_counterclockwise: '🔄', repeat: '🔁', arrow_forward: '▶️',
      fast_forward: '⏩', rewind: '⏪', play_or_pause_button: '⏯️',
      heavy_plus_sign: '➕', heavy_minus_sign: '➖', heavy_division_sign: '➗',
      heavy_multiplication_x: '✖️', infinity: '♾️', copyright: '©️',
      registered: '®️', tm: '™️', hash: '#️⃣', asterisk: '*️⃣',
      red_circle: '🔴', large_blue_circle: '🔵', white_circle: '⚪',
      black_circle: '⚫', green_circle: '🟢', yellow_circle: '🟡',
      orange_circle: '🟠', purple_circle: '🟣', small_red_triangle: '🔺',
      small_red_triangle_down: '🔻', diamond_shape_with_a_dot_inside: '💠',
      radio_button: '🔘', ballot_box_with_check: '☑️', o: '⭕',
      100: '💯', sos: '🆘', new: '🆕', free: '🆓', up: '🆙', ok: '🆗',
      cool: '🆒', abc: '🔤', capital_abcd: '🔠', symbols: '🔣',
    },
  },
]

// A Map, not an object literal: `:constructor:` and `:toString:` are valid
// shortcode spellings, and a bare object would resolve them to functions off
// Object.prototype.
const EMOJI = new Map(EMOJI_GROUPS.flatMap((g) => Object.entries(g.entries)))

// The character for a shortcode, or null when it is not one we carry — in
// which case the caller must leave the text exactly as written.
export function emojiFor(name) {
  return EMOJI.get(name) ?? null
}

// Shortcodes whose name contains `query`, in table order, for the picker's
// search. An empty query means "everything", so the caller can show the groups
// instead. Substring rather than prefix: nobody remembers whether it is
// `chart_with_upwards_trend` or `upwards_chart`.
export function searchEmoji(query) {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, '')
  if (!q) return []
  const out = []
  for (const group of EMOJI_GROUPS) {
    for (const [name, char] of Object.entries(group.entries)) {
      if (name.includes(q)) out.push({ name, char })
    }
  }
  return out
}
