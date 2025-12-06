import express from 'express';
import mongoose from 'mongoose';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import cors from 'cors';
import aws from 'aws-sdk';

import User from './Schema/User.js';
import Blog from './Schema/blog.js';

// ----- MongoDB Connection Reuse -----
let cached = global.mongoose;
if (!cached) cached = global.mongoose = { conn: null, promise: null };

async function connectToDatabase(uri) {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      autoIndex: true,
    }).then((mongoose) => mongoose);
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

// ----- Express App -----
const app = express();
app.use(express.json());
app.use(cors());

// Regex for validation
const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/;

// ----- AWS S3 Setup -----
const s3 = new aws.S3({
  region: "eu-north-1",
  accessKeyId: process.env.MY_AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const generateUploadURL = async () => {
  const imageName = `${nanoid()}-${Date.now()}.jpeg`;
  return s3.getSignedUrlPromise('putObject', {
    Bucket: 'blogging-website-ytassignment',
    Key: imageName,
    Expires: 600, // 10 minutes
    ContentType: 'image/jpeg',
  });
};

// ----- Helper Functions -----
const formatUser = (user) => ({
  profile_img: user.personal_info.profile_img,
  username: user.personal_info.username,
  fullname: user.personal_info.fullname,
});

const generateUsername = async (email) => {
  let username = email.split('@')[0];
  const exists = await User.exists({ 'personal_info.username': username });
  if (exists) username += nanoid().substring(0, 5);
  return username;
};

// ----- Routes -----
// Get upload URL
app.get('/get-upload-url', async (req, res) => {
  try {
    await connectToDatabase(process.env.MY_DB_LOCATION);
    const url = await generateUploadURL();
    res.status(200).json({ uploadURL: url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// Signup
app.post('/signup', async (req, res) => {
  try {
    await connectToDatabase(process.env.MY_DB_LOCATION);
    const { fullname = '', email = '', password = '' } = req.body;

    if (fullname.length < 3) return res.status(400).json({ error: 'Full name too short' });
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (!passwordRegex.test(password)) return res.status(400).json({ error: 'Weak password' });

    const existingUser = await User.findOne({ 'personal_info.email': email });
    if (existingUser) return res.status(409).json({ error: 'Email already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const username = await generateUsername(email);

    const newUser = new User({
      personal_info: { fullname, email, password: hashedPassword, username }
    });

    const savedUser = await newUser.save();
    res.status(201).json(formatUser(savedUser));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Signin
app.post('/signin', async (req, res) => {
  try {
    await connectToDatabase(process.env.MY_DB_LOCATION);
    const { email, password } = req.body;

    const user = await User.findOne({ 'personal_info.email': email });
    if (!user) return res.status(403).json({ error: 'Email not found please enter the valid email' });

    const isMatch = await bcrypt.compare(password, user.personal_info.password);
    if (!isMatch) return res.status(403).json({ error: 'Incorrect password' });

    res.status(200).json(formatUser(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Latest blogs
app.get('/latest-blogs', async (req, res) => {
  try {
    await connectToDatabase(process.env.MY_DB_LOCATION);
    const blogs = await Blog.find({ draft: false })
      .populate('author', 'personal_info.profile_img personal_info.username personal_info.fullname -_id')
      .sort({ publishedAt: -1 })
      .select('blog_id title des tags banner activity publishedAt -_id')
      .limit(5);

    res.status(200).json({ blogs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch blogs' });
  }
});

// Create blog
app.post('/create-blog', async (req, res) => {
  try {
    await connectToDatabase(process.env.MY_DB_LOCATION);
    let { title, des, banner, tags, content, draft } = req.body;

    if (!title?.length) return res.status(403).json({ error: 'Title required' });
    if (!des?.length || des.length > 200) return res.status(403).json({ error: 'Description max 200 chars' });
    if (!banner?.length) return res.status(403).json({ error: 'Banner required' });
    if (!content?.blocks?.length) return res.status(403).json({ error: 'Content required' });
    if (!tags?.length || tags.length > 10) return res.status(403).json({ error: 'Tags required (max 10)' });

    tags = tags.map(tag => tag.toLowerCase());

    const blog_id = title.replace(/[^a-zA-Z0-9]/g, ' ')
                         .replace(/\s+/g, '-')
                         .trim() + nanoid();

    const blog = new Blog({
      title,
      des,
      banner,
      content,
      tags,
      author: null,
      blog_id,
      draft: Boolean(draft),
    });

    const savedBlog = await blog.save();
    res.status(200).json({ id: savedBlog.blog_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create blog' });
  }
});

// ----- Export for Vercel Serverless -----
export default app;
