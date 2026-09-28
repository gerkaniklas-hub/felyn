-- M4b: Demo Provider & Experience Seed Data
-- Run this once in the Supabase SQL Editor, after 0002_providers_experiences.sql
-- has been applied. Uses the M4 schema exactly as-is — no DDL, no schema changes.
--
-- Fictional demo marketplace inventory only (Maria, Lucas, Sofia, Daniel are
-- NOT real Felyn providers). All four providers are intentionally "unclaimed"
-- (user_id = null) — see the comment on the providers table in 0002 for why.
--
-- Every row below uses a fixed, hardcoded UUID instead of the column's
-- gen_random_uuid() default, so provider_id/experience_id relationships
-- within this file are stable and every insert can target its natural
-- conflict key. That also makes the whole migration safe to re-run: every
-- statement is `on conflict ... do nothing`, so running it twice just skips
-- rows that already exist instead of duplicating demo data.
--
-- ID scheme (all fake, clearly non-colliding with gen_random_uuid() output):
--   1xxxxxxx-... providers            4xxxxxxx-... service_locations
--   2xxxxxxx-... experiences          5xxxxxxx-... experience_gallery
--   3xxxxxxx-... provider_gallery     6xxxxxxx-... experience_availability
-- Per-provider experience/gallery/etc. ids share a suffix block: Maria 01-03,
-- Lucas 11-13, Sofia 21-23, Daniel 31-33.

-- ── providers ────────────────────────────────────────────────────────────
insert into public.providers (id, user_id, display_name, profile_photo_url, bio, base_location, verification_status)
values
  (
    '10000000-0000-4000-8000-000000000001', null, 'Maria Delgado',
    'https://assets.felyn-demo.test/providers/maria/portrait.jpg',
    'Maria grew up a few streets from the harbour in Los Cristianos, learning to cook from her grandmother''s kitchen where the catch of the day decided the menu. Fifteen years later she still buys her fish each morning from the same local fishermen and turns it into unhurried, candlelit dinners for small groups of guests.',
    'Tenerife, Spain', 'verified'
  ),
  (
    '10000000-0000-4000-8000-000000000002', null, 'Lucas Fernández',
    'https://assets.felyn-demo.test/providers/lucas/portrait.jpg',
    'Lucas left Buenos Aires for Tenerife a decade ago and brought his family''s asado tradition with him — a wood fire, prime cuts, and an unhurried Sunday-lunch pace. He now fires up that same grill for small groups, pairing the classics with the Spanish wines and produce he''s grown to love.',
    'Tenerife, Spain', 'verified'
  ),
  (
    '10000000-0000-4000-8000-000000000003', null, 'Sofia Ricci',
    'https://assets.felyn-demo.test/providers/sofia/portrait.jpg',
    'Sofia moved from Bologna to Tenerife with one suitcase and her grandmother''s pasta recipes. She teaches small groups to roll fresh tagliatelle by hand before sitting everyone down, family-style, for a properly unhurried Italian dinner.',
    'Tenerife, Spain', 'verified'
  ),
  (
    '10000000-0000-4000-8000-000000000004', null, 'Daniel Sato',
    'https://assets.felyn-demo.test/providers/daniel/portrait.jpg',
    'Daniel trained in Tokyo before moving to Tenerife, where he now brings restaurant-level sushi to private tables — sourcing the freshest local fish and building each course in front of his guests.',
    'Tenerife, Spain', 'verified'
  )
on conflict (id) do nothing;

-- ── provider_languages ───────────────────────────────────────────────────
insert into public.provider_languages (provider_id, language)
values
  ('10000000-0000-4000-8000-000000000001', 'Spanish'),
  ('10000000-0000-4000-8000-000000000001', 'English'),
  ('10000000-0000-4000-8000-000000000002', 'Spanish'),
  ('10000000-0000-4000-8000-000000000002', 'English'),
  ('10000000-0000-4000-8000-000000000003', 'Italian'),
  ('10000000-0000-4000-8000-000000000003', 'English'),
  ('10000000-0000-4000-8000-000000000003', 'Spanish'),
  ('10000000-0000-4000-8000-000000000004', 'Japanese'),
  ('10000000-0000-4000-8000-000000000004', 'English'),
  ('10000000-0000-4000-8000-000000000004', 'Spanish')
on conflict (provider_id, language) do nothing;

-- ── provider_gallery ─────────────────────────────────────────────────────
insert into public.provider_gallery (id, provider_id, image_url, caption, sort_order)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'https://assets.felyn-demo.test/providers/maria/gallery-1.jpg', 'Maria selecting the morning catch at the harbour market', 1),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'https://assets.felyn-demo.test/providers/maria/gallery-2.jpg', 'Plating up for a sunset table', 2),
  ('30000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000002', 'https://assets.felyn-demo.test/providers/lucas/gallery-1.jpg', 'Lucas tending the wood-fired grill', 1),
  ('30000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000002', 'https://assets.felyn-demo.test/providers/lucas/gallery-2.jpg', 'Prime cuts ready for the fire', 2),
  ('30000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000003', 'https://assets.felyn-demo.test/providers/sofia/gallery-1.jpg', 'Rolling fresh tagliatelle by hand', 1),
  ('30000000-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000003', 'https://assets.felyn-demo.test/providers/sofia/gallery-2.jpg', 'A family-style table, mid-dinner', 2),
  ('30000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000004', 'https://assets.felyn-demo.test/providers/daniel/gallery-1.jpg', 'Daniel slicing fish for an omakase course', 1),
  ('30000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000004', 'https://assets.felyn-demo.test/providers/daniel/gallery-2.jpg', 'A finished nigiri course, plated', 2)
on conflict (id) do nothing;

-- ── service_locations ────────────────────────────────────────────────────
-- Lucas also has a temporary future service location in Ibiza, to exercise
-- the "current base vs. temporary elsewhere" model the schema supports.
insert into public.service_locations (id, provider_id, location_text, latitude, longitude, starts_at, ends_at, is_current)
values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Costa Adeje & Los Cristianos, Tenerife', 28.0916, -16.7405, null, null, true),
  ('40000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000002', 'South Tenerife (Costa Adeje, Los Cristianos, Playa de las Américas)', 28.0916, -16.7405, null, null, true),
  ('40000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000002', 'Ibiza, Spain (summer season)', 38.9067, 1.4206, '2027-06-01', '2027-09-15', false),
  ('40000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000003', 'North Tenerife (Puerto de la Cruz, La Orotava)', 28.4158, -16.5464, null, null, true),
  ('40000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000004', 'South Tenerife (Costa Adeje, Playa de las Américas)', 28.0916, -16.7405, null, null, true)
on conflict (id) do nothing;

-- ── experiences ──────────────────────────────────────────────────────────
insert into public.experiences (
  id, provider_id, title, short_description, description, category, cuisine,
  price_per_person, currency, min_guests, max_guests, duration_minutes, published
)
values
  (
    '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
    'Sunset Seafood Dinner',
    'A candlelit, catch-of-the-day dinner on the terrace as the sun goes down.',
    'Maria builds the whole menu around whatever came off the boats that morning — usually a starter of local cheese and pickled vegetables, a whole grilled fish to share, and a Canarian-style dessert. Served at a single long table, timed for sunset.',
    'food', 'Mediterranean', 65.00, 'EUR', 2, 8, 150, true
  ),
  (
    '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
    'Canarian Tapas & Mojo Night',
    'A relaxed spread of small plates, wrinkled potatoes, and Maria''s three house mojo sauces.',
    'A sociable, help-yourself evening of Canarian classics — croquetas, grilled octopus, papas arrugadas with mojo rojo and mojo verde — designed for groups who want to graze and talk rather than sit through formal courses.',
    'food', 'Canarian', 45.00, 'EUR', 2, 12, 120, true
  ),
  (
    '20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
    'Family-Style Paella Feast',
    'One giant pan of seafood or vegetable paella, cooked outdoors and served family-style.',
    'Maria cooks the paella outdoors over an open flame while guests watch, then serves it straight from the pan at a shared table — a relaxed, celebratory option for bigger groups and birthdays.',
    'food', 'Spanish', 40.00, 'EUR', 4, 16, 135, true
  ),
  (
    '20000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000002',
    'Argentinian Asado Night',
    'A full wood-fire asado — chorizo, short ribs and steak — cooked slowly the traditional way.',
    'Lucas lights the fire hours before guests arrive and cooks everything low and slow the way his family always has, serving each cut as it comes off the grill alongside chimichurri and grilled vegetables.',
    'food', 'Argentinian', 55.00, 'EUR', 4, 14, 180, true
  ),
  (
    '20000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000002',
    'Fireside BBQ & Wine',
    'An intimate fire-lit BBQ for smaller groups, paired with Spanish reds.',
    'A more intimate take on Lucas''s asado — fewer guests, a curated wine pairing, and a slower pace built for couples or small celebrations around the fire.',
    'food', 'Argentinian-Spanish fusion', 60.00, 'EUR', 2, 10, 150, true
  ),
  (
    '20000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000002',
    'Canarian Wine & Rum Tasting',
    'A guided tasting of Tenerife''s volcanic wines and local rums.',
    'Lucas walks guests through five local wines and two rums grown and distilled on the island, with light snacks to match — a relaxed, conversational tasting rather than a formal dinner.',
    'drink', 'Canarian', 35.00, 'EUR', 2, 10, 90, true
  ),
  (
    '20000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000003',
    'Homemade Pasta Night',
    'Roll fresh tagliatelle by hand with Sofia, then sit down to eat what you made.',
    'An interactive evening that starts at the counter, rolling and cutting fresh pasta from scratch, and ends at the table with the dish you made plus a simple Italian starter and dessert.',
    'food', 'Italian', 50.00, 'EUR', 2, 10, 150, true
  ),
  (
    '20000000-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000003',
    'Mediterranean Family Feast',
    'A big, shared table of Mediterranean classics built for bigger family groups.',
    'Sofia''s take on a proper family Sunday lunch — antipasti, a shared pasta course, and a main to pass around — designed for reunions, birthdays and bigger holiday groups.',
    'food', 'Italian-Mediterranean', 42.00, 'EUR', 4, 16, 130, true
  ),
  (
    '20000000-0000-4000-8000-000000000023', '10000000-0000-4000-8000-000000000003',
    'Wine & Tapas Evening',
    'A relaxed evening of Italian and Spanish small plates paired with regional wines.',
    'A grazing menu of Italian and Canarian tapas, each course paired with a different regional wine — built for couples or small groups who want good food and good wine without a rigid structure.',
    'food_drink', 'Italian-Spanish', 48.00, 'EUR', 2, 12, 120, true
  ),
  (
    '20000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000004',
    'Sushi Making Experience',
    'Learn to roll your own nigiri and maki with Daniel before eating what you made.',
    'A hands-on class covering rice preparation, knife technique, and rolling, followed by a shared meal of everything the group made together — a fun, interactive option for friends.',
    'food', 'Japanese', 58.00, 'EUR', 2, 8, 150, true
  ),
  (
    '20000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000004',
    'Omakase Tasting Menu',
    'A premium, chef''s-choice tasting menu built course by course at your table.',
    'Daniel''s highest-end offering — a multi-course omakase built entirely around what is freshest that day, plated and explained course by course for a small, intimate group.',
    'food', 'Japanese', 95.00, 'EUR', 2, 6, 120, true
  ),
  (
    '20000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000004',
    'Sake & Sushi Pairing',
    'A guided sake tasting paired course by course with Daniel''s sushi.',
    'Five courses of sushi and sashimi, each paired with a different sake, with Daniel explaining the pairing as he serves it — an intimate, educational evening for couples or small groups.',
    'food_drink', 'Japanese', 75.00, 'EUR', 2, 8, 135, true
  )
on conflict (id) do nothing;

-- ── experience_attributes ───────────────────────────────────────────────
insert into public.experience_attributes (experience_id, attribute_type, attribute_value)
values
  -- Sunset Seafood Dinner
  ('20000000-0000-4000-8000-000000000001', 'atmosphere', 'intimate'),
  ('20000000-0000-4000-8000-000000000001', 'setting', 'outdoor'),
  ('20000000-0000-4000-8000-000000000001', 'style', 'premium'),
  ('20000000-0000-4000-8000-000000000001', 'occasion', 'anniversary'),
  ('20000000-0000-4000-8000-000000000001', 'specialty', 'seafood'),
  ('20000000-0000-4000-8000-000000000001', 'dietary', 'pescatarian-friendly'),
  -- Canarian Tapas & Mojo Night
  ('20000000-0000-4000-8000-000000000002', 'atmosphere', 'social'),
  ('20000000-0000-4000-8000-000000000002', 'setting', 'outdoor'),
  ('20000000-0000-4000-8000-000000000002', 'style', 'family-style'),
  ('20000000-0000-4000-8000-000000000002', 'occasion', 'friends_getaway'),
  ('20000000-0000-4000-8000-000000000002', 'specialty', 'tapas'),
  ('20000000-0000-4000-8000-000000000002', 'dietary', 'vegetarian-friendly'),
  -- Family-Style Paella Feast
  ('20000000-0000-4000-8000-000000000003', 'atmosphere', 'celebratory'),
  ('20000000-0000-4000-8000-000000000003', 'setting', 'outdoor'),
  ('20000000-0000-4000-8000-000000000003', 'style', 'family-style'),
  ('20000000-0000-4000-8000-000000000003', 'occasion', 'birthday'),
  ('20000000-0000-4000-8000-000000000003', 'specialty', 'paella'),
  ('20000000-0000-4000-8000-000000000003', 'dietary', 'gluten-free-friendly'),
  -- Argentinian Asado Night
  ('20000000-0000-4000-8000-000000000011', 'atmosphere', 'social'),
  ('20000000-0000-4000-8000-000000000011', 'setting', 'outdoor'),
  ('20000000-0000-4000-8000-000000000011', 'style', 'interactive'),
  ('20000000-0000-4000-8000-000000000011', 'occasion', 'friends_getaway'),
  ('20000000-0000-4000-8000-000000000011', 'specialty', 'bbq'),
  -- Fireside BBQ & Wine
  ('20000000-0000-4000-8000-000000000012', 'atmosphere', 'intimate'),
  ('20000000-0000-4000-8000-000000000012', 'setting', 'outdoor'),
  ('20000000-0000-4000-8000-000000000012', 'style', 'premium'),
  ('20000000-0000-4000-8000-000000000012', 'occasion', 'couples_trip'),
  ('20000000-0000-4000-8000-000000000012', 'specialty', 'bbq'),
  -- Canarian Wine & Rum Tasting
  ('20000000-0000-4000-8000-000000000013', 'atmosphere', 'relaxed'),
  ('20000000-0000-4000-8000-000000000013', 'setting', 'indoor'),
  ('20000000-0000-4000-8000-000000000013', 'style', 'educational'),
  ('20000000-0000-4000-8000-000000000013', 'occasion', 'friends_getaway'),
  ('20000000-0000-4000-8000-000000000013', 'specialty', 'wine'),
  ('20000000-0000-4000-8000-000000000013', 'dietary', 'vegan-friendly'),
  -- Homemade Pasta Night
  ('20000000-0000-4000-8000-000000000021', 'atmosphere', 'social'),
  ('20000000-0000-4000-8000-000000000021', 'setting', 'indoor'),
  ('20000000-0000-4000-8000-000000000021', 'style', 'interactive'),
  ('20000000-0000-4000-8000-000000000021', 'occasion', 'friends_getaway'),
  ('20000000-0000-4000-8000-000000000021', 'specialty', 'pasta'),
  ('20000000-0000-4000-8000-000000000021', 'dietary', 'vegetarian-friendly'),
  -- Mediterranean Family Feast
  ('20000000-0000-4000-8000-000000000022', 'atmosphere', 'celebratory'),
  ('20000000-0000-4000-8000-000000000022', 'setting', 'outdoor'),
  ('20000000-0000-4000-8000-000000000022', 'style', 'family-style'),
  ('20000000-0000-4000-8000-000000000022', 'occasion', 'reunion'),
  ('20000000-0000-4000-8000-000000000022', 'specialty', 'mediterranean'),
  ('20000000-0000-4000-8000-000000000022', 'dietary', 'vegetarian-friendly'),
  -- Wine & Tapas Evening
  ('20000000-0000-4000-8000-000000000023', 'atmosphere', 'relaxed'),
  ('20000000-0000-4000-8000-000000000023', 'setting', 'indoor'),
  ('20000000-0000-4000-8000-000000000023', 'style', 'premium'),
  ('20000000-0000-4000-8000-000000000023', 'occasion', 'couples_trip'),
  ('20000000-0000-4000-8000-000000000023', 'specialty', 'wine'),
  ('20000000-0000-4000-8000-000000000023', 'dietary', 'vegetarian-friendly'),
  -- Sushi Making Experience
  ('20000000-0000-4000-8000-000000000031', 'atmosphere', 'social'),
  ('20000000-0000-4000-8000-000000000031', 'setting', 'indoor'),
  ('20000000-0000-4000-8000-000000000031', 'style', 'interactive'),
  ('20000000-0000-4000-8000-000000000031', 'occasion', 'friends_getaway'),
  ('20000000-0000-4000-8000-000000000031', 'specialty', 'sushi'),
  ('20000000-0000-4000-8000-000000000031', 'dietary', 'pescatarian-friendly'),
  -- Omakase Tasting Menu
  ('20000000-0000-4000-8000-000000000032', 'atmosphere', 'intimate'),
  ('20000000-0000-4000-8000-000000000032', 'setting', 'indoor'),
  ('20000000-0000-4000-8000-000000000032', 'style', 'premium'),
  ('20000000-0000-4000-8000-000000000032', 'occasion', 'anniversary'),
  ('20000000-0000-4000-8000-000000000032', 'specialty', 'sushi'),
  ('20000000-0000-4000-8000-000000000032', 'dietary', 'pescatarian-friendly'),
  -- Sake & Sushi Pairing
  ('20000000-0000-4000-8000-000000000033', 'atmosphere', 'intimate'),
  ('20000000-0000-4000-8000-000000000033', 'setting', 'indoor'),
  ('20000000-0000-4000-8000-000000000033', 'style', 'educational'),
  ('20000000-0000-4000-8000-000000000033', 'occasion', 'couples_trip'),
  ('20000000-0000-4000-8000-000000000033', 'specialty', 'sushi'),
  ('20000000-0000-4000-8000-000000000033', 'dietary', 'pescatarian-friendly')
on conflict (experience_id, attribute_type, attribute_value) do nothing;

-- ── experience_gallery ───────────────────────────────────────────────────
insert into public.experience_gallery (id, experience_id, image_url, caption, sort_order)
values
  ('50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'https://assets.felyn-demo.test/experiences/maria-sunset-seafood/1.jpg', 'The table set for sunset', 1),
  ('50000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'https://assets.felyn-demo.test/experiences/maria-tapas-mojo/1.jpg', 'A spread of Canarian tapas and mojo sauces', 1),
  ('50000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 'https://assets.felyn-demo.test/experiences/maria-paella/1.jpg', 'Paella cooking over an open flame', 1),
  ('50000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000011', 'https://assets.felyn-demo.test/experiences/lucas-asado/1.jpg', 'Short ribs on the wood fire', 1),
  ('50000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000012', 'https://assets.felyn-demo.test/experiences/lucas-fireside-bbq/1.jpg', 'An intimate fireside table for two', 1),
  ('50000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000013', 'https://assets.felyn-demo.test/experiences/lucas-wine-rum/1.jpg', 'A flight of local wines and rums', 1),
  ('50000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000021', 'https://assets.felyn-demo.test/experiences/sofia-pasta-night/1.jpg', 'Fresh tagliatelle, hand-rolled', 1),
  ('50000000-0000-4000-8000-000000000022', '20000000-0000-4000-8000-000000000022', 'https://assets.felyn-demo.test/experiences/sofia-family-feast/1.jpg', 'A shared table of Mediterranean dishes', 1),
  ('50000000-0000-4000-8000-000000000023', '20000000-0000-4000-8000-000000000023', 'https://assets.felyn-demo.test/experiences/sofia-wine-tapas/1.jpg', 'Wine and small plates, paired course by course', 1),
  ('50000000-0000-4000-8000-000000000031', '20000000-0000-4000-8000-000000000031', 'https://assets.felyn-demo.test/experiences/daniel-sushi-making/1.jpg', 'Guests rolling their own maki', 1),
  ('50000000-0000-4000-8000-000000000032', '20000000-0000-4000-8000-000000000032', 'https://assets.felyn-demo.test/experiences/daniel-omakase/1.jpg', 'A single course of the omakase menu', 1),
  ('50000000-0000-4000-8000-000000000033', '20000000-0000-4000-8000-000000000033', 'https://assets.felyn-demo.test/experiences/daniel-sake-sushi/1.jpg', 'Sake paired with a sashimi course', 1)
on conflict (id) do nothing;

-- ── experience_availability ─────────────────────────────────────────────
-- Intentionally simple: one open date window per experience with a typical
-- sitting time and a rough capacity, not a real calendar.
insert into public.experience_availability (id, experience_id, available_from, available_until, start_time, end_time, max_bookings)
values
  ('60000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '2026-10-01', '2027-06-30', '19:00', '21:30', 40),
  ('60000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '2026-09-20', '2027-09-19', '19:30', '21:30', 60),
  ('60000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', '2026-10-01', '2027-06-30', '13:00', '15:15', 30),
  ('60000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000011', '2026-09-20', '2027-09-19', '19:00', '22:00', 50),
  ('60000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000012', '2026-10-01', '2027-06-30', '19:30', '22:00', 30),
  ('60000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000013', '2026-09-20', '2027-09-19', '18:00', '19:30', 60),
  ('60000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000021', '2026-09-20', '2027-09-19', '18:30', '21:00', 45),
  ('60000000-0000-4000-8000-000000000022', '20000000-0000-4000-8000-000000000022', '2026-10-01', '2027-06-30', '13:00', '15:10', 25),
  ('60000000-0000-4000-8000-000000000023', '20000000-0000-4000-8000-000000000023', '2026-09-20', '2027-09-19', '19:00', '21:00', 40),
  ('60000000-0000-4000-8000-000000000031', '20000000-0000-4000-8000-000000000031', '2026-09-20', '2027-09-19', '18:00', '20:30', 40),
  ('60000000-0000-4000-8000-000000000032', '20000000-0000-4000-8000-000000000032', '2026-10-01', '2027-06-30', '19:30', '21:30', 20),
  ('60000000-0000-4000-8000-000000000033', '20000000-0000-4000-8000-000000000033', '2026-09-20', '2027-09-19', '19:00', '21:15', 25)
on conflict (id) do nothing;
