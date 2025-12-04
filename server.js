import express from 'express';
import mongoose from 'mongoose';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import cors from 'cors';
import aws from "aws-sdk";

import User from './Schema/User.js';
import Blog from './Schema/blog.js';

const server = express();
const PORT = process.env.PORT || 3000;

const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/;

server.use(express.json());
server.use(cors());

// Connect to MongoDB
mongoose.connect(process.env.MY_DB_LOCATION, { autoIndex: true })
  .then(async () => {
    console.log("Connected to MongoDB Atlas");
    await User.syncIndexes();
    await Blog.syncIndexes();
  })
  .catch(err => console.error("MongoDB connection error:", err));

// AWS S3 setup
const s3 = new aws.S3({
  region: "eu-north-1",
  accessKeyId: process.env.MY_AWS_ACCESS_KEY,
  secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY
});

const generateUploadURL = async () => {
  const date = new Date();
  const imageName = `${nanoid()}-${date.getTime()}.jpeg`;
  return await s3.getSignedUrlPromise('putObject', {
    Bucket: 'blogging-website-ytassignment',
    Key: imageName,
    Expires: 1000,
    ContentType: "image/jpeg"
  });
};

// Helpers
const formatDataToSend = (user) => {
  return {
    profile_img: user.personal_info.profile_img,
    username: user.personal_info.username,
    fullname: user.personal_info.fullname,
  };
};

const generateUsername = async (email) => {
  let username = email.split("@")[0];
  const exists = await User.exists({ "personal_info.username": username });
  if (exists) username += nanoid().substring(0, 5);
  return username;
};

// Routes

server.get('/get-upload-url', async (req, res) => {
  try {
    const url = await generateUploadURL();
    res.status(200).json({ uploadURL: url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Signup route
server.post("/signup", async (req, res) => {
  const { fullname = "", email = "", password = "" } = req.body;

  if (fullname.length < 3) return res.status(400).json({ error: "Full name must be at least 3 characters" });
  if (!email || !emailRegex.test(email)) return res.status(400).json({ error: "Invalid email" });
  if (!passwordRegex.test(password)) return res.status(400).json({ error: "Password must have 6-20 chars, 1 uppercase, 1 lowercase, 1 number" });

  try {
    const existingUser = await User.findOne({ "personal_info.email": email });
    if (existingUser) return res.status(409).json({ error: "Email already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const username = await generateUsername(email);

    const newUser = new User({
      personal_info: { fullname, email, password: hashedPassword, username }
    });

    const savedUser = await newUser.save();
    res.status(201).json(formatDataToSend(savedUser));

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Signin route
server.post("/signin", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ "personal_info.email": email });
    if (!user) return res.status(403).json({ error: "Email not found" });

    const isMatch = await bcrypt.compare(password, user.personal_info.password);
    if (!isMatch) return res.status(403).json({ error: "Incorrect password" });

    return res.status(200).json(formatDataToSend(user));

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

server.get('/latest-blogs', (req, res) => {
  const maxLimit = 5;

  Blog.find({ draft: false })
    .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
    .sort({ publishedAt: -1 })   // FIXED typo
    .select("blog_id title des tags banner activity publishedAt -_id")
    .limit(maxLimit)
    .then(blogs => {
      res.status(200).json({ blogs });
    })
    .catch(err => {
      res.status(500).json({ error: err.message });
    });
});

// Create blog route (NO access token required)
server.post('/create-blog', async (req, res) => {
  let { title, des, banner, tags, content, draft } = req.body;

  if (!title || !title.length) {
    return res.status(403).json({ error: "You must provide a title to publish the blog" });
  }

  if (!des || !des.length || des.length > 200) {
    return res.status(403).json({ error: "You must provide blog description under 200 characters" });
  }

  if (!banner || !banner.length) {
    return res.status(403).json({ error: "You must provide a blog banner to publish it" });
  }

  if (!content || !content.blocks || !content.blocks.length) {
    return res.status(403).json({ error: "There must be some blog content to publish it" });
  }

  if (!tags || !tags.length || tags.length > 10) {
    return res.status(403).json({ error: "Provide tags to publish the blog" });
  }

  tags = tags.map(tag => tag.toLowerCase());

  const blog_id = title.replace(/[^a-zA-Z0-9]/g, ' ')
                       .replace(/\s+/g, "-")
                       .trim() + nanoid();

  try {
    let blog = new Blog({
      title,
      des,
      banner,
      content,
      tags,
      author: null,  // No token = no author
      blog_id,
      draft: Boolean(draft),
    });

    const savedBlog = await blog.save();

    return res.status(200).json({ id: savedBlog.blog_id });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
